import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { enforce } from '@/lib/rate-limit'
import { sql } from '@/lib/db'
import { serverEnv } from '@/env'
import { verifyCheckoutSignature } from '@/lib/razorpay/verify'
import { applyPaymentById } from '@/lib/orders'
import { audit } from '@/lib/audit'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { readJson } from '@/lib/body'
import { requireApiKey } from '@/lib/api-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The browser callback. ADVISORY ONLY — a latency optimisation so the customer
 * sees "paid" without waiting for the webhook.
 *
 * Razorpay is explicit that the signature is not proof of settlement:
 *   "Check the payment/order status, that is if the payment's status is
 *    captured and the order's status is paid before proving the services."
 *
 * So this route does three things in order:
 *   1. verify the HMAC (anti-tamper)
 *   2. resolve the order by the UNIQUE razorpay_order_id — NOT by a
 *      client-supplied internal id
 *   3. re-read truth from GET /v1/payments/:id and require `captured`
 *
 * Fulfilment itself runs through the same idempotent path the webhook uses, so
 * whichever arrives first wins and the second is a no-op.
 */
const Body = z.object({
  razorpay_order_id: z.string().min(4).max(64),
  razorpay_payment_id: z.string().min(4).max(64),
  razorpay_signature: z.string().length(64),
})

export async function POST(request: Request) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    const session = await requireUser()
    await enforce('confirmPerUser', session.userId)

    const parsed = Body.safeParse(await readJson(request))
    if (!parsed.success) fail('invalid_request', parsed.error.message)
    const body = parsed.data

    const ok = verifyCheckoutSignature({
      orderId: body.razorpay_order_id,
      paymentId: body.razorpay_payment_id,
      signature: body.razorpay_signature,
      keySecret: serverEnv().RAZORPAY_KEY_SECRET,
    })

    if (!ok) {
      await audit({
        event: 'callback_signature_invalid',
        outcome: 'failure',
        userId: session.userId,
        detail: { razorpayOrderId: body.razorpay_order_id },
      })
      fail('forbidden', 'callback signature invalid')
    }

    // Resolve by the unique razorpay_order_id, and confirm it belongs to this
    // caller. A valid signature for someone else's order must not be actionable.
    const rows = (await sql`
      select id, user_id, status from orders
       where razorpay_order_id = ${body.razorpay_order_id} limit 1
    `) as unknown as Array<{ id: string; user_id: string | null; status: string }>

    const order = rows[0]
    if (!order) fail('not_found', 'no order for that razorpay_order_id')
    if (order.user_id !== session.userId) fail('forbidden', 'order belongs to another user')

    await audit({
      event: 'callback_verified',
      outcome: 'success',
      userId: session.userId,
      orderId: order.id,
    })

    // Re-read truth. This is also where a tampered amount would be caught:
    // app.apply_payment_event refuses a captured payment whose amount/currency
    // does not match the order exactly.
    const result = await applyPaymentById(body.razorpay_payment_id)

    return NextResponse.json({
      orderId: order.id,
      status: result?.status ?? order.status,
      // `paid` only ever comes from a genuinely captured payment.
      paid: result?.status === 'paid',
      receiptNo: result?.receipt_no ?? null,
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
