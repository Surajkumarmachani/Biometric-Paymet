import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@clerk/nextjs/server'
import { requireUser } from '@/lib/auth'
import { enforce, clientIp } from '@/lib/rate-limit'
import { claimOrder } from '@/lib/orders'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { formatINR } from '@/lib/money'
import { requireApiKey } from '@/lib/api-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Bind an in-store order to the customer who scanned the QR.
 *
 * This is a separate authenticated POST rather than a side effect of loading
 * /pay/[token], for two reasons:
 *
 *   * at page load there is no authenticated user yet, so there is nobody to
 *     bind the order to
 *   * a GET must not mutate state
 *
 * app.claim_order is idempotent for the SAME user (so a page refresh is fine)
 * and single-winner across DIFFERENT users (so two customers scanning the same
 * code cannot both take the order).
 */
const Body = z.object({ token: z.string().min(20).max(200) })

export async function POST(request: Request) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    const ip = clientIp(request.headers)
    await enforce('claimPerIp', ip)

    const session = await requireUser()
    await enforce('claimPerUser', session.userId)

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) fail('invalid_request', parsed.error.message)

    const user = await currentUser()
    const email = user?.primaryEmailAddress?.emailAddress ?? null

    const order = await claimOrder({
      token: parsed.data.token,
      userId: session.userId,
      email,
    })

    return NextResponse.json({
      orderId: order.orderId,
      amountPaise: order.amountPaise,
      amountDisplay: formatINR(order.amountPaise),
      currency: order.currency,
      status: order.status,
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
