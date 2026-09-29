import 'server-only'
import { sql, rpc } from './db'
import { applyPaymentById, reconcileOrder } from './orders'
import { fetchDispute } from './razorpay/api'
import { issueCreditNote } from './credit-note'
import { audit, alertOn } from './audit'
import { toPaise } from './money'

/**
 * The webhook ledger drain and the order reconciler.
 *
 * A ledger with no consumer is a queue that fills forever, so this is not
 * optional plumbing — without it nothing is ever fulfilled. Drive both from a
 * Vercel Cron every minute hitting /api/internal/drain and
 * /api/internal/reconcile.
 *
 * The drain deliberately ignores each payload's `status` field and re-reads
 * truth from the API. Razorpay warns that payment.authorized reflects state at
 * authorization "even if it subsequently moves to captured state", and events
 * can arrive out of order. Re-reading makes the worker state-convergent rather
 * than sequence-dependent, which is what makes out-of-order delivery harmless.
 */

interface LedgerRow {
  event_id: string
  event_type: string
  payload: {
    payload?: {
      payment?: { entity?: { id?: string } }
      order?: { entity?: { id?: string } }
      refund?: {
        entity?: {
          id?: string
          payment_id?: string
          amount?: number
          status?: string
        }
      }
      dispute?: {
        entity?: {
          id?: string
          payment_id?: string
          amount?: number
          status?: string
          respond_by?: number
        }
      }
    }
  }
  attempts: number
}

export interface DrainReport {
  claimed: number
  processed: number
  failed: number
  dead: number
}

export async function drainWebhooks(batchSize = 25): Promise<DrainReport> {
  const rows = (await sql`
    select * from app.claim_webhook_batch(${batchSize})
  `) as unknown as LedgerRow[]

  const report: DrainReport = { claimed: rows.length, processed: 0, failed: 0, dead: 0 }

  for (const row of rows) {
    try {
      await handleEvent(row)
      await rpc(sql`select app.finish_webhook(${row.event_id}, true)`)
      report.processed++
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      await rpc(sql`select app.finish_webhook(${row.event_id}, false, ${detail})`)
      report.failed++

      // 8 attempts is the dead-letter threshold in app.finish_webhook. Past
      // that nobody retries it again, so it must page someone.
      if (row.attempts >= 8) {
        report.dead++
        alertOn('webhook_dead', { eventId: row.event_id, eventType: row.event_type, detail })
        await audit({
          event: 'webhook_dead',
          outcome: 'failure',
          detail: { eventId: row.event_id, eventType: row.event_type, error: detail },
        })
      }
    }
  }

  return report
}

async function handleEvent(row: LedgerRow): Promise<void> {
  const p = row.payload?.payload ?? {}
  const type = row.event_type

  // --- payments -------------------------------------------------------------
  // payment.captured and order.paid FIRE TOGETHER. Both funnel into the same
  // idempotent path; app.apply_payment_event's fulfilled_at latch means only
  // one of them can trigger side effects.
  if (
    type === 'payment.captured' ||
    type === 'payment.authorized' ||
    type === 'payment.failed' ||
    type === 'order.paid'
  ) {
    const paymentId = p.payment?.entity?.id
    if (paymentId) {
      await applyPaymentById(paymentId)
      return
    }
    // order.paid can in principle arrive without a payment entity. Fall back to
    // reconciling every attempt on the order.
    const orderId = p.order?.entity?.id
    if (orderId) {
      await reconcileOrder(orderId)
      return
    }
    throw new Error(`${type}: no payment or order id in payload`)
  }

  // --- refunds --------------------------------------------------------------
  if (type.startsWith('refund.')) {
    const r = p.refund?.entity
    if (!r?.id || !r.payment_id) throw new Error(`${type}: incomplete refund entity`)
    const out = await rpc<{ order_id: string }>(sql`
      select app.apply_refund(
        ${r.payment_id},
        ${r.id},
        ${toPaise(r.amount ?? 0)},
        ${r.status ?? 'created'}
      )
    `)
    // Money actually returned → issue a GST credit note (idempotent on refund id).
    if (r.status === 'processed' && out.order_id) {
      const cn = await issueCreditNote({
        orderId: out.order_id,
        ref: r.id,
        reason: 'refund',
        amountPaise: toPaise(r.amount ?? 0),
      })
      if (cn) {
        await audit({ event: 'credit_note_issued', outcome: 'success', orderId: out.order_id, detail: { creditNoteNo: cn.credit_note_no, reason: 'refund' } })
      }
    }
    return
  }

  // --- disputes -------------------------------------------------------------
  if (type.startsWith('payment.dispute.')) {
    const hinted = p.dispute?.entity
    if (!hinted?.id) throw new Error(`${type}: incomplete dispute entity`)
    // Re-read truth, same as payments: the payload is a snapshot from when the
    // event fired, and a stale one used to be able to un-chargeback an order.
    const d = await fetchDispute(hinted.id)
    const status = d.status
    const out = await rpc<{ order_id: string; status: string }>(sql`
      select app.apply_dispute(
        ${d.payment_id},
        ${d.id},
        ${d.status},
        ${d.amount == null ? null : toPaise(d.amount)},
        ${d.respond_by ? new Date(d.respond_by * 1000).toISOString() : null}
      )
    `)
    alertOn('dispute_opened', { disputeId: d.id, paymentId: d.payment_id, status })

    // A lost dispute clawed the money back → issue a GST credit note against the
    // original invoice (idempotent on dispute id).
    if (out.status === 'charged_back' && out.order_id) {
      const cn = await issueCreditNote({
        orderId: out.order_id,
        ref: d.id,
        reason: 'chargeback',
        amountPaise: d.amount == null ? undefined : toPaise(d.amount),
      })
      if (cn) {
        await audit({ event: 'credit_note_issued', outcome: 'success', orderId: out.order_id, detail: { creditNoteNo: cn.credit_note_no, reason: 'chargeback' } })
      }
    }
    return
  }

  // Anything else (payment.downtime.*, settlement.*) is acknowledged and
  // ignored rather than retried forever.
  console.log(JSON.stringify({ level: 'info', event: 'webhook_ignored', type }))
}

export interface ReconcileReport {
  claimed: number
  resolved: number
  stillPending: number
  errors: number
}

/**
 * Poll orders that are due.
 *
 * app.claim_due_orders owns the schedule: 10s, 20s, 40s, 60s, 120s, then every
 * 60s to the 15-minute wall, after which the order becomes `abandoned` but is
 * STILL polled hourly for 24h — UPI late authorisation is routine, and an order
 * we gave up on can still take the customer's money.
 */
export async function reconcileDueOrders(batchSize = 50): Promise<ReconcileReport> {
  const rows = (await sql`
    select * from app.claim_due_orders(${batchSize})
  `) as unknown as Array<{
    order_id: string
    razorpay_order_id: string
    status: string
    poll_attempts: number
  }>

  const report: ReconcileReport = {
    claimed: rows.length,
    resolved: 0,
    stillPending: 0,
    errors: 0,
  }

  for (const row of rows) {
    try {
      const out = await reconcileOrder(row.razorpay_order_id)
      if (out.status === 'paid' || out.status === 'payment_failed') report.resolved++
      else report.stillPending++
    } catch (err) {
      report.errors++
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'reconcile_failed',
          orderId: row.order_id,
          detail: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  return report
}
