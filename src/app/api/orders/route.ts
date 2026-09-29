import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentUser } from '@clerk/nextjs/server'
import { requireUser } from '@/lib/auth'
import { enforce } from '@/lib/rate-limit'
import { createWebOrder } from '@/lib/orders'
import { decideRails, expectedGestures } from '@/lib/rails'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { readJson } from '@/lib/body'
import { formatINR } from '@/lib/money'
import { requireApiKey } from '@/lib/api-keys'

// Node runtime: postgres.js and node:crypto. force-dynamic because a cached
// order-creation route is a production incident.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Web entry point.
 *
 * Note what the body does NOT contain: any amount. The client sends skus and
 * quantities; app.create_order prices every line from product_prices. This is
 * the root of trust that every downstream "server-derived amount" claim rests
 * on, so it must never grow an `amount` field.
 */
const Body = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().min(1).max(64),
        qty: z.number().int().min(1).max(99),
      }),
    )
    .min(1)
    .max(50),
  // Client-supplied so a double-tap is idempotent. Also used as the Razorpay
  // `receipt`, hence the 40-char ceiling.
  idempotencyKey: z.string().min(8).max(40),
})

export async function POST(request: Request) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    const session = await requireUser()
    await enforce('orderCreatePerUser', session.userId)

    const parsed = Body.safeParse(await readJson(request))
    if (!parsed.success) fail('invalid_request', parsed.error.message)

    const user = await currentUser()
    const email = user?.primaryEmailAddress?.emailAddress ?? null

    const order = await createWebOrder({
      userId: session.userId,
      lines: parsed.data.lines,
      idempotencyKey: parsed.data.idempotencyKey,
      email,
    })

    const rails = decideRails(order.amountPaise)

    return NextResponse.json({
      orderId: order.orderId,
      amountPaise: order.amountPaise,
      amountDisplay: formatINR(order.amountPaise),
      currency: order.currency,
      replayed: order.replayed,
      rails: {
        available: rails.available,
        blocked: rails.blocked,
        preferred: rails.preferred,
        upiCapDisplay: formatINR(rails.upiCapPaise),
        expectation: expectedGestures(rails, rails.preferred),
      },
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
