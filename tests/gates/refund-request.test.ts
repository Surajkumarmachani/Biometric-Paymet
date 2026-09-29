import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, paise, expectDenied, ALICE, BOB, PRIYA, STORE, idem, type TestDb } from '../setup/pg'

/**
 * Gate: CUSTOMER REFUND REQUESTS (0013).
 *
 * A request is an ask, not a refund. The invariants that matter:
 *   * only the order's owner can open one, and only on a captured payment
 *   * at most ONE open request per order (a partial unique index, so the
 *     double-submit race has no window to exploit)
 *   * the amount can never exceed what is still refundable, and "refundable"
 *     counts pending refunds as committed — the same rule the refund route uses
 *   * a real refund closes the ask; nothing else silently marks it approved
 *   * one customer cannot read or withdraw another's
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('refundreq') })
afterAll(async () => { await db?.drop() })

/** A paid order for `user`, captured in full. */
async function paidOrder(user = ALICE, sku = 'RL-CUFF-01'): Promise<{ id: string; amount: number }> {
  const o = one<{ order_id: string; amount_paise: number }>(
    await db.sql`select app.create_order(${user},
      ${db.sql.json([{ sku, qty: 1 }])}::jsonb, ${idem('rr')})`,
  )
  await db.sql`
    update orders set status = 'paid', amount_captured_paise = amount_paise
     where id = ${o.order_id}::uuid
  `
  return { id: o.order_id, amount: paise(o.amount_paise) }
}

interface Outcome {
  ok: boolean
  reason?: string
  request_id?: string
  amount_paise?: number
  refundable_paise?: number
  status?: string
}

const request = async (
  orderId: string,
  user: string,
  reason = 'wrong size',
  amount: number | null = null,
): Promise<Outcome> =>
  one<Outcome>(
    await db.sql`select app.request_refund(${orderId}::uuid, ${user}, ${reason}, ${amount})`,
  )

describe('app.request_refund', () => {
  it('opens a request for the full refundable amount by default', async () => {
    const order = await paidOrder()
    const out = await request(order.id, ALICE)

    expect(out.ok).toBe(true)
    expect(paise(out.amount_paise)).toBe(order.amount)
    expect(out.status).toBe('pending')
  })

  it('allows a partial ask below the refundable amount', async () => {
    const order = await paidOrder()
    const out = await request(order.id, ALICE, 'one stone loose', 100_000)

    expect(out.ok).toBe(true)
    expect(paise(out.amount_paise)).toBe(100_000)
  })

  it('refuses an amount above what is refundable', async () => {
    const order = await paidOrder()
    const out = await request(order.id, ALICE, 'greedy', order.amount + 1)

    expect(out.ok).toBe(false)
    expect(out.reason).toBe('amount_out_of_range')
    expect(paise(out.refundable_paise)).toBe(order.amount)
  })

  it('refuses a second open request on the same order', async () => {
    const order = await paidOrder()
    const first = await request(order.id, ALICE)
    const second = await request(order.id, ALICE, 'again')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(second.reason).toBe('already_open')

    const rows = (await db.sql`
      select count(*)::int as n from refund_requests
       where order_id = ${order.id}::uuid and status = 'pending'
    `) as unknown as Array<{ n: number }>
    expect(rows[0]!.n).toBe(1)
  })

  it('is not another customer’s to open', async () => {
    const order = await paidOrder(ALICE)
    const out = await request(order.id, BOB)

    expect(out.ok).toBe(false)
    expect(out.reason).toBe('not_yours')
  })

  it('refuses an order that never captured', async () => {
    const o = one<{ order_id: string }>(
      await db.sql`select app.create_order(${ALICE},
        ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb, ${idem('rr')})`,
    )
    const out = await request(o.order_id, ALICE)

    expect(out.ok).toBe(false)
    expect(out.reason).toBe('not_refundable')
    expect(out.status).toBe('draft')
  })

  it('requires a reason', async () => {
    const order = await paidOrder()
    await expect(request(order.id, ALICE, '   ')).rejects.toThrow(/reason required/i)
  })
})

describe('app.refundable_paise', () => {
  it('treats a PENDING refund as committed, so the ask cannot double-dip', async () => {
    const order = await paidOrder()
    // A refund Razorpay has accepted but not yet settled. orders
    // .amount_refunded_paise stays 0 (processed-only, by design) — the ceiling
    // must still come down, or the customer could ask for the money twice.
    await db.sql`
      insert into refunds (order_id, razorpay_refund_id, amount_paise, status)
      values (${order.id}::uuid, ${idem('rfnd')}, ${100_000}, 'pending')
    `

    const rows = (await db.sql`
      select app.refundable_paise(${order.id}::uuid)::text as p
    `) as unknown as Array<{ p: string }>
    expect(paise(rows[0]!.p)).toBe(order.amount - 100_000)

    const out = await request(order.id, ALICE, 'the rest', order.amount)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('amount_out_of_range')
  })

  it('reports nothing left once the full amount is committed', async () => {
    const order = await paidOrder()
    await db.sql`
      insert into refunds (order_id, razorpay_refund_id, amount_paise, status)
      values (${order.id}::uuid, ${idem('rfnd')}, ${order.amount}, 'processed')
    `
    const out = await request(order.id, ALICE)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('nothing_left')
  })
})

describe('withdraw / decline / approve', () => {
  it('withdrawing frees the order for a fresh request', async () => {
    const order = await paidOrder()
    await request(order.id, ALICE)

    const w = one<{ ok: boolean; status?: string }>(
      await db.sql`select app.withdraw_refund_request(${order.id}::uuid, ${ALICE})`,
    )
    expect(w.ok).toBe(true)
    expect(w.status).toBe('withdrawn')

    // The partial unique index only covers 'pending', so this is now allowed.
    const again = await request(order.id, ALICE, 'changed my mind back')
    expect(again.ok).toBe(true)
  })

  it('is not another customer’s to withdraw', async () => {
    const order = await paidOrder(ALICE)
    await request(order.id, ALICE)

    const w = one<{ ok: boolean; reason?: string }>(
      await db.sql`select app.withdraw_refund_request(${order.id}::uuid, ${BOB})`,
    )
    expect(w.ok).toBe(false)
    expect(w.reason).toBe('no_open_request')
  })

  it('declines with a note, and only while open', async () => {
    const order = await paidOrder()
    // PRIYA manages STORE; a manager only decides for their own store (0017).
    await db.sql`update orders set store_id = ${STORE}::uuid where id = ${order.id}::uuid`
    const opened = await request(order.id, ALICE)

    const d = one<{ ok: boolean; status?: string }>(
      await db.sql`select app.decline_refund_request(
        ${opened.request_id}::uuid, ${PRIYA}, ${'worn items, past 30 days'})`,
    )
    expect(d.ok).toBe(true)
    expect(d.status).toBe('declined')

    const rows = (await db.sql`
      select decision_note, decided_by from refund_requests
       where id = ${opened.request_id}::uuid
    `) as unknown as Array<{ decision_note: string; decided_by: string }>
    expect(rows[0]!.decision_note).toBe('worn items, past 30 days')
    expect(rows[0]!.decided_by).toBe(PRIYA)

    // Declining twice is a stale view, not a second decision.
    const twice = one<{ ok: boolean; reason?: string }>(
      await db.sql`select app.decline_refund_request(${opened.request_id}::uuid, ${PRIYA}, ${null})`,
    )
    expect(twice.ok).toBe(false)
    expect(twice.reason).toBe('not_open')
  })

  it('a refund closes the open ask', async () => {
    const order = await paidOrder()
    await request(order.id, ALICE)

    const closed = one<number>(
      await db.sql`select app.approve_open_refund_requests(${order.id}::uuid, ${PRIYA})`,
    )
    expect(Number(closed)).toBe(1)

    const rows = (await db.sql`
      select status, decided_by from refund_requests where order_id = ${order.id}::uuid
    `) as unknown as Array<{ status: string; decided_by: string }>
    expect(rows[0]!.status).toBe('approved')
    expect(rows[0]!.decided_by).toBe(PRIYA)
  })

  it('a staff-initiated refund invents no request', async () => {
    const order = await paidOrder()
    const closed = one<number>(
      await db.sql`select app.approve_open_refund_requests(${order.id}::uuid, ${PRIYA})`,
    )
    expect(Number(closed)).toBe(0)

    const rows = (await db.sql`
      select count(*)::int as n from refund_requests where order_id = ${order.id}::uuid
    `) as unknown as Array<{ n: number }>
    expect(rows[0]!.n).toBe(0)
  })
})

describe('RLS on refund_requests', () => {
  it('a customer reads their own request', async () => {
    const order = await paidOrder(ALICE)
    await request(order.id, ALICE)

    const rows = await db.asAuthenticated(ALICE, (tx) => tx`
      select id from refund_requests where order_id = ${order.id}::uuid
    `)
    expect(rows.length).toBe(1)
  })

  it('another customer cannot', async () => {
    const order = await paidOrder(ALICE)
    await request(order.id, ALICE)

    await expectDenied(() => db.asAuthenticated(BOB, (tx) => tx`
      select id from refund_requests where order_id = ${order.id}::uuid
    `))
  })

  it('anon cannot', async () => {
    const order = await paidOrder(ALICE)
    await request(order.id, ALICE)

    await expectDenied(() => db.asAnon((tx) => tx`
      select id from refund_requests where order_id = ${order.id}::uuid
    `))
  })
})

describe('managers decide only for their own store (0017)', () => {
  it("cannot decline another store's or a web order's request", async () => {
    const order = await paidOrder() // web order: no store
    const opened = await request(order.id, ALICE)
    const d = one<{ ok: boolean; reason?: string }>(
      await db.sql`select app.decline_refund_request(${opened.request_id}::uuid, ${PRIYA}, ${null})`,
    )
    // Reported like a stale view: nothing about another store's queue leaks.
    expect(d.ok).toBe(false)
    expect(d.reason).toBe('not_open')
  })
})
