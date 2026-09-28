import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { enforce } from '@/lib/rate-limit'
import { sql } from '@/lib/db'
import { reconcileOrder } from '@/lib/orders'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { formatINR, toPaise } from '@/lib/money'
import { requireApiKey } from '@/lib/api-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Client poll target for the closed-app case.
 *
 * The customer taps UPI, their app takes over, and our browser context is gone —
 * so the checkout `handler` never fires. That is normal, not an error. The UI
 * shows "confirming payment…" and polls here.
 *
 * For the first couple of minutes this route also does an inline reconcile,
 * which covers the sub-minute steps of the backoff schedule that a
 * once-a-minute cron cannot express. After that the cron takes over.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    const session = await requireUser()
    await enforce('statusPerUser', session.userId)

    const { id } = await context.params
    if (!z.string().uuid().safeParse(id).success) fail('invalid_request', 'bad order id')

    const rows = (await sql`
      select id, user_id, store_id, status, amount_paise, currency, receipt_no,
             razorpay_order_id, awaiting_since,
             amount_captured_paise, amount_refunded_paise
        from orders where id = ${id}::uuid limit 1
    `) as unknown as Array<{
      id: string
      user_id: string | null
      store_id: string | null
      status: string
      amount_paise: string
      currency: string
      receipt_no: string | null
      razorpay_order_id: string | null
      awaiting_since: string | null
      amount_captured_paise: string
      amount_refunded_paise: string
    }>

    const order = rows[0]
    if (!order) fail('not_found', 'order not found')

    /**
     * Who may poll this order.
     *
     * The customer, obviously. But ALSO the staff running the in-store
     * terminal, which is a different person from the payer in every real
     * handover — the associate builds the order, the customer pays on their own
     * phone. Before this, an owner-only check meant the terminal's fallback
     * poll got a 403 for every genuine in-store sale and the tile could only
     * ever be updated by Realtime.
     *
     * Scoped like the staff order list: associates see their own store,
     * managers and admins see any. Read-only either way — this route moves no
     * money.
     */
    if (order.user_id !== session.userId) {
      const staff = (await sql`
        select store_id, role from staff
         where clerk_id = ${session.userId} and active
         limit 1
      `) as unknown as Array<{ store_id: string; role: string }>

      const row = staff[0]
      const privileged = row?.role === 'manager' || row?.role === 'admin'
      const sameStore = !!row && !!order.store_id && row.store_id === order.store_id
      if (!row || !(privileged || sameStore)) fail('forbidden', 'not your order')
    }

    // Inline fast reconcile while the payment is genuinely fresh.
    let status = order.status
    if (
      order.status === 'awaiting_payment' &&
      order.razorpay_order_id &&
      order.awaiting_since &&
      Date.now() - new Date(order.awaiting_since).getTime() < 120_000
    ) {
      try {
        const out = await reconcileOrder(order.razorpay_order_id)
        if (out.status) status = out.status
      } catch {
        // A reconcile failure must not fail the poll — the cron will retry.
      }
    }

    const terminal = ['paid', 'refunded', 'charged_back', 'payment_failed'].includes(status)

    return NextResponse.json({
      orderId: order.id,
      status,
      paid: status === 'paid',
      // Tells the client whether to keep polling or stop.
      settled: terminal,
      amountPaise: toPaise(order.amount_paise),
      amountDisplay: formatINR(toPaise(order.amount_paise)),
      amountCapturedPaise: toPaise(order.amount_captured_paise),
      amountRefundedPaise: toPaise(order.amount_refunded_paise),
      receiptNo: order.receipt_no,
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
