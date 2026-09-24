import { NextResponse } from 'next/server'
import { assertInternalSecret } from '@/lib/auth'
import { reconcileDueOrders } from '@/lib/drain'
import { errorResponse, newRequestId } from '@/lib/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Order reconciler. Schedule every minute alongside the drain.
 *
 * This is the safety net for the dominant UPI failure mode: the customer's app
 * took over, our callback never fired, and we never learned a payment id. It
 * asks Razorpay for ALL payments on the order, which works even with no payment
 * id in hand.
 *
 * Sub-minute steps in the backoff are covered by the client polling
 * /api/orders/[id]/status for the first couple of minutes; this cron catches
 * everything after that, plus webhook outages and late authorisations.
 */
async function run(request: Request) {
  const requestId = newRequestId()
  try {
    assertInternalSecret(
      request.headers.get('x-internal-secret') ??
        request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
        null,
    )
    const report = await reconcileDueOrders(50)
    return NextResponse.json({ ...report, requestId })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}

export const GET = run
export const POST = run
