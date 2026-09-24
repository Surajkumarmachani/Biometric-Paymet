import 'server-only'
import { sql } from './db'
import { toPaise, formatINR } from './money'

/**
 * Customer refund requests — the read side.
 *
 * Writes all go through the `app.*` functions in 0013 (one open request per
 * order is a partial unique index, not application logic). This module is only
 * for reading them back for display, in the two places that need it: the
 * customer's own order page and the staff queue.
 */

export type RefundRequestStatus = 'pending' | 'approved' | 'declined' | 'withdrawn'

export interface RefundRequest {
  id: string
  orderId: string
  status: RefundRequestStatus
  amountPaise: number
  amountDisplay: string
  reason: string
  decisionNote: string | null
  /** Already formatted for Asia/Kolkata — these only ever go to a screen. */
  at: string
  decidedAt: string | null
}

interface Row {
  id: string
  order_id: string
  status: RefundRequestStatus
  amount_paise: string
  reason: string
  decision_note: string | null
  created_at: string
  decided_at: string | null
}

function when(ts: string): string {
  return new Date(ts).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function map(r: Row): RefundRequest {
  const amountPaise = toPaise(r.amount_paise)
  return {
    id: r.id,
    orderId: r.order_id,
    status: r.status,
    amountPaise,
    amountDisplay: formatINR(amountPaise),
    reason: r.reason,
    decisionNote: r.decision_note,
    at: when(r.created_at),
    decidedAt: r.decided_at ? when(r.decided_at) : null,
  }
}

/**
 * The most recent request on an order, whatever its status.
 *
 * Latest rather than open-only on purpose: a customer who has just been
 * declined needs to see the decline and its reason, not an empty panel that
 * invites them to ask again as though nothing happened.
 */
export async function latestRefundRequest(orderId: string): Promise<RefundRequest | null> {
  const rows = (await sql`
    select id, order_id, status, amount_paise, reason, decision_note,
           created_at, decided_at
      from refund_requests
     where order_id = ${orderId}::uuid
     order by created_at desc
     limit 1
  `) as unknown as Row[]
  return rows[0] ? map(rows[0]) : null
}

/** How much of an order is still refundable. Mirrors the refund route's rule. */
export async function refundablePaise(orderId: string): Promise<number> {
  const rows = (await sql`
    select app.refundable_paise(${orderId}::uuid)::text as paise
  `) as unknown as Array<{ paise: string }>
  return toPaise(rows[0]?.paise ?? '0')
}

/**
 * Open requests for a set of orders, keyed by order id.
 *
 * One query for the whole staff list rather than one per row — the list renders
 * up to 50 orders and the queue badge is on every one of them.
 */
export async function openRequestsByOrder(
  orderIds: string[],
): Promise<Map<string, RefundRequest>> {
  if (orderIds.length === 0) return new Map()

  const rows = (await sql`
    select id, order_id, status, amount_paise, reason, decision_note,
           created_at, decided_at
      from refund_requests
     where status = 'pending'
       and order_id = any(${orderIds}::uuid[])
  `) as unknown as Row[]

  return new Map(rows.map((r) => [r.order_id, map(r)]))
}
