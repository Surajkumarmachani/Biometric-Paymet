import 'server-only'
import type { TransactionSql } from 'postgres'
import { sql, rpc, jsonb } from './db'
import { toPaise, type Paise } from './money'
import { fail } from './errors'
import { audit, alertOn } from './audit'
import { createRazorpayOrder, fetchPayment, fetchOrderPayments, paymentToEvent } from './razorpay/api'
import { hashClaimToken, randomToken } from './razorpay/verify'
import { assessOrderAmount } from './risk'
import { issueInvoiceForOrder } from './invoice'

/**
 * Service layer over the `app.*` functions.
 *
 * Routes stay thin and every money-critical guarantee stays in SQL. In
 * particular: no function in this file accepts an amount from a caller. Amounts
 * are always read from the database.
 */

export type OrderStatus =
  | 'draft'
  | 'claimed'
  | 'intent_verified'
  | 'awaiting_payment'
  | 'payment_failed'
  | 'paid'
  | 'abandoned'
  | 'disputed'
  | 'charged_back'
  | 'refunded'

export interface CartLine {
  sku: string
  qty: number
}

export interface CreatedOrder {
  order_id: string
  amount_paise: string | number
  currency: string
  status: OrderStatus
  line_items?: unknown
  replayed: boolean
}

/**
 * Just-in-time user provisioning.
 *
 * orders.user_id is FK -> app_users(clerk_id), so a Clerk user must have a row
 * here before any order can reference them. In production a Clerk `user.created`
 * webhook keeps app_users in sync; this idempotent upsert is the safety net so a
 * brand-new customer's first order (web or claimed QR) never fails the FK.
 */
export async function ensureAppUser(userId: string, email?: string | null): Promise<void> {
  await sql`
    insert into app_users (clerk_id, email)
    values (${userId}, ${email ?? null})
    on conflict (clerk_id) do update
      set email = coalesce(app_users.email, excluded.email)
  `
}

/**
 * Price and risk-screen an order in ONE transaction.
 *
 * The risk cap used to run after app.create_order had committed: an over-cap
 * order existed as a real `draft` until a follow-up delete, so a concurrent
 * request with the same idempotency key could replay it (skipping screening)
 * and a crash between the two left a payable over-cap order behind. Now an
 * over-cap order is rolled back before anyone else can see it.
 *
 * A replay is not re-screened: nothing over the cap can ever have committed.
 * The high-value alert fires after commit, for an order that really exists.
 */
async function createScreenedOrder(
  create: (tx: TransactionSql) => ReturnType<typeof sql>,
  who: { userId?: string | null; staffId?: string | null },
): Promise<CreatedOrder> {
  let declined: { amountPaise: Paise; maxOrderPaise: number; code: string } | null = null

  let out: CreatedOrder
  try {
    out = await sql.begin(async (tx) => {
      const created = await rpc<CreatedOrder>(create(tx))
      if (!created.replayed) {
        const amountPaise = toPaise(created.amount_paise)
        const risk = assessOrderAmount(amountPaise)
        if (!risk.allowed) {
          declined = { amountPaise, maxOrderPaise: risk.maxOrderPaise, code: risk.code }
          throw new Error('risk_declined') // rolls the order back
        }
      }
      return created
    })
  } catch (err) {
    if (!declined) throw err
    const d = declined as { amountPaise: Paise; maxOrderPaise: number; code: string }
    await audit({
      event: 'risk_declined',
      outcome: 'failure',
      userId: who.userId ?? null,
      orderId: null,
      detail: { amountPaise: d.amountPaise, maxOrderPaise: d.maxOrderPaise, reason: d.code, staffId: who.staffId ?? null },
    })
    fail('risk_declined', `order amount ${d.amountPaise} exceeds cap ${d.maxOrderPaise}`)
  }

  if (!out.replayed && assessOrderAmount(toPaise(out.amount_paise)).flags.includes('high_value')) {
    alertOn('high_value_order', { orderId: out.order_id, amountPaise: toPaise(out.amount_paise), userId: who.userId ?? null })
    await audit({
      event: 'high_value_order',
      outcome: 'success',
      userId: who.userId ?? null,
      orderId: out.order_id,
      detail: { amountPaise: toPaise(out.amount_paise) },
    })
  }
  return out
}

/** Web entry: the customer's own cart. Client sends {sku, qty} — never money. */
export async function createWebOrder(args: {
  userId: string
  lines: CartLine[]
  idempotencyKey: string
  email?: string | null
}): Promise<{ orderId: string; amountPaise: Paise; currency: string; replayed: boolean }> {
  await ensureAppUser(args.userId, args.email)

  const out = await createScreenedOrder(
    (tx) => tx`
      select app.create_order(
        ${args.userId},
        ${jsonb(args.lines)}::jsonb,
        ${args.idempotencyKey}
      )
    `,
    { userId: args.userId },
  )

  await audit({
    event: 'order_created',
    outcome: 'success',
    userId: args.userId,
    orderId: out.order_id,
    detail: { entry: 'web', replayed: out.replayed },
  })

  return {
    orderId: out.order_id,
    amountPaise: toPaise(out.amount_paise),
    currency: out.currency,
    replayed: out.replayed,
  }
}

/**
 * In-store entry: staff builds the order, we mint a claim token and return the
 * PLAINTEXT token exactly once for the QR. Only its sha256 is stored.
 */
export async function createStoreOrder(args: {
  lines: CartLine[]
  idempotencyKey: string
  storeId: string
  staffId: string
  claimTtlSeconds?: number
}): Promise<{
  orderId: string
  amountPaise: Paise
  currency: string
  claimToken: string
  replayed: boolean
}> {
  const claimToken = randomToken(32)

  const out = await createScreenedOrder(
    (tx) => tx`
      select app.create_order(
        ${null},
        ${jsonb(args.lines)}::jsonb,
        ${args.idempotencyKey},
        ${args.storeId}::uuid,
        ${args.staffId},
        ${hashClaimToken(claimToken)},
        ${args.claimTtlSeconds ?? 900}
      )
    `,
    { staffId: args.staffId },
  )

  await audit({
    event: 'order_created',
    outcome: 'success',
    orderId: out.order_id,
    detail: { entry: 'in_store', storeId: args.storeId, staffId: args.staffId },
  })

  return {
    orderId: out.order_id,
    amountPaise: toPaise(out.amount_paise),
    currency: out.currency,
    claimToken,
    replayed: out.replayed,
  }
}

/**
 * Read-only lookup for the QR landing page. Mutates nothing — there is no
 * authenticated user yet at that point.
 */
export async function peekOrderByClaimToken(token: string): Promise<{
  orderId: string
  amountPaise: Paise
  currency: string
  status: OrderStatus
  lineItems: unknown
  expired: boolean
  claimable: boolean
} | null> {
  const rows = (await sql`
    select id, amount_paise, currency, status, line_items,
           claim_token_expires_at < now() as expired,
           user_id
      from orders
     where claim_token_hash = ${hashClaimToken(token)}
     limit 1
  `) as unknown as Array<{
    id: string
    amount_paise: string
    currency: string
    status: OrderStatus
    line_items: unknown
    expired: boolean
    user_id: string | null
  }>

  const row = rows[0]
  if (!row) return null

  return {
    orderId: row.id,
    amountPaise: toPaise(row.amount_paise),
    currency: row.currency,
    status: row.status,
    lineItems: row.line_items,
    expired: row.expired,
    claimable: !row.expired && (row.status === 'draft' || row.status === 'claimed'),
  }
}

/** Idempotent claim. First authenticated POST wins; a refresh by the same user is fine. */
export async function claimOrder(args: {
  token: string
  userId: string
  email?: string | null
}): Promise<{ orderId: string; amountPaise: Paise; currency: string; status: OrderStatus }> {
  await ensureAppUser(args.userId, args.email)

  const out = await rpc<{
    claimed: boolean
    order_id?: string
    amount_paise?: string
    currency?: string
    status?: OrderStatus
  }>(sql`
    select app.claim_order(${hashClaimToken(args.token)}, ${args.userId})
  `)

  if (!out.claimed) {
    await audit({
      event: 'claim_rejected',
      outcome: 'failure',
      userId: args.userId,
      detail: { reason: 'expired, already claimed by another customer, or not claimable' },
    })
    fail('conflict', 'claim rejected')
  }

  await audit({
    event: 'order_claimed',
    outcome: 'success',
    userId: args.userId,
    orderId: out.order_id!,
  })

  return {
    orderId: out.order_id!,
    amountPaise: toPaise(out.amount_paise!),
    currency: out.currency!,
    status: out.status!,
  }
}

/**
 * Has this Clerk reverification already authorized a payment?
 *
 * A reverification is single-use (UNIQUE (kind, ref) on payment_authorizations),
 * but Clerk keeps the same reverification_id valid for the whole `afterMinutes`
 * window. So a second payment inside that window would reuse a spent id and hit
 * the replay guard. The authorize route checks this first and forces a fresh
 * step-up instead — one genuine verification per payment (threat 19), no dead end.
 */
export async function reverificationAlreadyUsed(reverificationId: string): Promise<boolean> {
  const rows = (await sql`
    select 1 from payment_authorizations
     where kind = 'clerk_reverification' and ref = ${reverificationId}
     limit 1
  `) as unknown as unknown[]
  return rows.length > 0
}

/**
 * Read the order's own amount, server-side, for the authorization step.
 * This is the only place the authorize route learns what the payment is worth.
 */
export async function readOrderForAuthorization(args: {
  orderId: string
  userId: string
}): Promise<{ amountPaise: Paise; currency: string; status: OrderStatus }> {
  const rows = (await sql`
    select amount_paise, currency, status
      from orders
     where id = ${args.orderId}::uuid and user_id = ${args.userId}
     limit 1
  `) as unknown as Array<{ amount_paise: string; currency: string; status: OrderStatus }>

  const row = rows[0]
  if (!row) fail('not_found', 'order not found for this user')
  return {
    amountPaise: toPaise(row.amount_paise),
    currency: row.currency,
    status: row.status,
  }
}

/**
 * Option A: record the Clerk reverification against the order.
 *
 * UNIQUE (kind, ref) in payment_authorizations makes a replayed
 * reverification_id a 23505, which errors.ts maps to `authorization_replayed`.
 */
export async function recordClerkAuthorization(args: {
  orderId: string
  userId: string
  reverificationId: string
  amountPaise: Paise
}): Promise<void> {
  try {
    await rpc(sql`
      select app.record_authorization(
        ${args.orderId}::uuid,
        'clerk_reverification'::auth_kind,
        ${args.reverificationId},
        ${args.userId},
        ${args.amountPaise}
      )
    `)
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      await audit({
        event: 'authorization_replayed',
        outcome: 'failure',
        userId: args.userId,
        orderId: args.orderId,
      })
    }
    throw err
  }

  await audit({
    event: 'authorization_recorded',
    outcome: 'success',
    userId: args.userId,
    orderId: args.orderId,
    detail: { kind: 'clerk_reverification' },
  })
}

/**
 * Ensure the order has a Razorpay order, creating one only if absent.
 *
 * ONE Razorpay order per order, reused across retries. Minting a fresh one on
 * retry orphans the previous order, and a payment against an orphan is
 * invisible to the reconciler — customer charged, order abandoned, no alert.
 */
export async function ensureRazorpayOrder(args: {
  orderId: string
  userId: string | null
}): Promise<{ razorpayOrderId: string; amountPaise: Paise; currency: string; created: boolean }> {
  const rows = (await sql`
    select amount_paise, currency, idempotency_key, razorpay_order_id, status
      from orders where id = ${args.orderId}::uuid limit 1
  `) as unknown as Array<{
    amount_paise: string
    currency: string
    idempotency_key: string
    razorpay_order_id: string | null
    status: OrderStatus
  }>

  const order = rows[0]
  if (!order) fail('not_found', 'order not found')
  if (!['intent_verified', 'awaiting_payment', 'payment_failed'].includes(order.status)) {
    fail('order_not_payable', `status ${order.status}`)
  }

  const amountPaise = toPaise(order.amount_paise)

  // Reuse path: no API call at all.
  if (order.razorpay_order_id) {
    const out = await rpc<{ razorpay_order_id: string; created: boolean }>(sql`
      select app.attach_razorpay_order(${args.orderId}::uuid, ${order.razorpay_order_id})
    `)
    await audit({
      event: 'razorpay_order_reused',
      outcome: 'success',
      userId: args.userId,
      orderId: args.orderId,
      detail: { razorpayOrderId: out.razorpay_order_id },
    })
    return {
      razorpayOrderId: out.razorpay_order_id,
      amountPaise,
      currency: order.currency,
      created: false,
    }
  }

  const created = await createRazorpayOrder({
    amountPaise, // from the database, never from a request
    currency: order.currency,
    receipt: order.idempotency_key,
    notes: { order_id: args.orderId },
  })

  const out = await rpc<{ razorpay_order_id: string; created: boolean }>(sql`
    select app.attach_razorpay_order(${args.orderId}::uuid, ${created.id})
  `)

  await audit({
    event: 'razorpay_order_created',
    outcome: 'success',
    userId: args.userId,
    orderId: args.orderId,
    detail: { razorpayOrderId: out.razorpay_order_id, amountPaise },
  })

  return {
    razorpayOrderId: out.razorpay_order_id,
    amountPaise,
    currency: order.currency,
    created: out.created,
  }
}

export interface ApplyResult {
  order_id: string
  previous_status: OrderStatus
  status: OrderStatus
  fulfil_now: boolean
  late_authorisation: boolean
  receipt_no: string | null
  amount_captured_paise: string
}

/**
 * Apply one payment fact to the order.
 *
 * ALWAYS called with truth re-read from GET /v1/payments/:id, never with a
 * webhook payload's `status` — Razorpay warns that payment.authorized reflects
 * state at authorization "even if it subsequently moves to captured state".
 * Re-reading is what makes out-of-order delivery harmless.
 */
export async function applyPaymentById(paymentId: string): Promise<ApplyResult | null> {
  const payment = await fetchPayment(paymentId)
  if (!payment.order_id) {
    // A payment with no order can only be a legacy/non-Orders-API flow.
    alertOn('webhook_rejected', { reason: 'payment has no order_id', paymentId })
    return null
  }
  return applyPaymentEvent(payment.order_id, payment)
}

async function applyPaymentEvent(
  razorpayOrderId: string,
  payment: Awaited<ReturnType<typeof fetchPayment>>,
): Promise<ApplyResult> {
  const e = paymentToEvent(payment)

  const out = await rpc<ApplyResult>(sql`
    select app.apply_payment_event(
      ${razorpayOrderId},
      ${e.razorpayPaymentId},
      ${e.status},
      ${e.amountPaise},
      ${e.currency},
      ${e.method},
      ${jsonb(e.error)}::jsonb,
      ${jsonb(e.acquirer)}::jsonb,
      ${e.feePaise},
      ${e.taxPaise}
    )
  `)

  if (out.late_authorisation) {
    // Customer has been charged on an order we had given up on. Someone must
    // either fulfil it or refund it — this cannot sit in a table unseen.
    alertOn('late_authorisation', {
      orderId: out.order_id,
      paymentId: e.razorpayPaymentId,
      amountPaise: e.amountPaise,
    })
    await audit({
      event: 'late_authorisation',
      outcome: 'success',
      orderId: out.order_id,
      detail: { paymentId: e.razorpayPaymentId },
    })
  }

  if (out.fulfil_now) {
    await audit({
      event: 'payment_captured',
      outcome: 'success',
      orderId: out.order_id,
      detail: { paymentId: e.razorpayPaymentId, receiptNo: out.receipt_no },
    })
    await runFulfilment(out)
  } else if (e.status === 'failed') {
    await audit({
      event: 'payment_failed',
      outcome: 'failure',
      orderId: out.order_id,
      detail: { paymentId: e.razorpayPaymentId, error: e.error },
    })
  }

  return out
}

/**
 * Side effects that must happen exactly once per order.
 *
 * `fulfil_now` is true only on the first transition into `paid` (fulfilled_at is
 * the latch, set in the same statement), so this is safe against the
 * payment.captured + order.paid co-fire and against webhook redelivery.
 */
async function runFulfilment(result: ApplyResult): Promise<void> {
  // The order row flipping to `paid` with a receipt_no is the fulfilment, and
  // the store terminal picks it up over Supabase Realtime.
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'fulfilled',
      orderId: result.order_id,
      receiptNo: result.receipt_no,
      amountCapturedPaise: result.amount_captured_paise,
    }),
  )

  // Issue the GST invoice (S5). Idempotent (one per order). Never let an invoice
  // failure unwind a fulfilment — a paid order with a delayed invoice is fine; a
  // captured payment with no order transition is not. Log and move on.
  try {
    const invoice = await issueInvoiceForOrder(result.order_id)
    if (invoice) {
      await audit({
        event: 'invoice_issued',
        outcome: 'success',
        orderId: result.order_id,
        detail: { invoiceNo: invoice.invoice_no },
      })
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'invoice_failed',
        orderId: result.order_id,
        detail: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

/**
 * Reconcile an order against Razorpay by asking for ALL its payments.
 *
 * Works even when we never received a payment id, which is exactly the
 * closed-UPI-app case. Because one Razorpay order is reused across retries,
 * this cannot miss an attempt.
 */
export async function reconcileOrder(razorpayOrderId: string): Promise<{
  attempts: number
  status: OrderStatus | null
}> {
  const payments = await fetchOrderPayments(razorpayOrderId)
  let last: ApplyResult | null = null

  // Apply captured last so a stale failure can never be the final word — the
  // SQL invariants already guarantee this, but ordering keeps the logs sane.
  const ordered = [...payments].sort(
    (a, b) => Number(a.status === 'captured') - Number(b.status === 'captured'),
  )

  for (const p of ordered) {
    last = await applyPaymentEvent(razorpayOrderId, p)
  }

  return { attempts: payments.length, status: last?.status ?? null }
}
