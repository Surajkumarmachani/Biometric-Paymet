import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth, reverificationError } from '@clerk/nextjs/server'
import { REVERIFY_CONFIG, reverificationIdFromClaims } from '@/lib/auth'
import { enforce } from '@/lib/rate-limit'
import {
  readOrderForAuthorization,
  recordClerkAuthorization,
  ensureRazorpayOrder,
  reverificationAlreadyUsed,
} from '@/lib/orders'
import { decideRails, expectedGestures } from '@/lib/rails'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { formatINR } from '@/lib/money'
import { requireApiKey } from '@/lib/api-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The gesture. Option A (Clerk reverification) from the architecture doc §4.1.
 *
 * A passkey/biometric (or first-factor) step-up performed within the last
 * minute is demanded — effectively "just now, for this payment". When it is
 * missing we return the Clerk reverification hint so the client pops the
 * step-up and retries; no Clerk / no reverification_id claim => no payment.
 *
 * Then the chain that makes the amount trustworthy:
 *
 *   1. read the order's amount from the DATABASE (never the request body)
 *   2. app.record_authorization writes reverification_id under
 *      UNIQUE (kind, ref) — that constraint is the single-use guarantee — and
 *      re-checks the amount against the order
 *   3. app.attach_razorpay_order creates OR reuses one Razorpay order
 *
 * The request body carries an orderId and nothing else. There is deliberately
 * no amount parameter anywhere in this path.
 */
const Body = z.object({ orderId: z.string().uuid() })

export async function POST(request: Request) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    // Step-up first: no reason to touch the database for an unverified caller.
    const a = await auth()
    if (!a.userId) fail('unauthenticated')

    // If the customer has not reverified within the window, return the Clerk
    // reverification HINT (not a plain 403). The client's useReverification hook
    // recognises this shape, pops the passkey/password step-up, and retries.
    if (!a.has({ reverification: REVERIFY_CONFIG })) {
      return NextResponse.json(reverificationError(REVERIFY_CONFIG), { status: 403 })
    }

    const userId = a.userId
    const reverificationId = reverificationIdFromClaims(a.sessionClaims)
    if (!reverificationId) {
      // The step-up happened but the claim is absent — a Clerk dashboard
      // misconfiguration, not something the user can retry past.
      fail(
        'forbidden',
        'reverification_id claim missing — add {"reverification_id":"{{session.reverification_id}}"} to the Clerk session token',
      )
    }

    // If this reverification was already spent (Clerk keeps it valid for the
    // whole window), don't hit the replay guard — force a fresh step-up so the
    // customer performs one genuine verification for THIS payment.
    if (await reverificationAlreadyUsed(reverificationId)) {
      return NextResponse.json(reverificationError(REVERIFY_CONFIG), { status: 403 })
    }

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) fail('invalid_request', parsed.error.message)
    const { orderId } = parsed.data

    await enforce('payOptionsPerUser', userId)
    await enforce('payOptionsPerOrder', orderId)

    // The amount comes from here and nowhere else.
    const order = await readOrderForAuthorization({ orderId, userId })

    await recordClerkAuthorization({
      orderId,
      userId,
      reverificationId,
      amountPaise: order.amountPaise,
    })

    const rzp = await ensureRazorpayOrder({ orderId, userId })

    const rails = decideRails(rzp.amountPaise)
    if (rails.available.length === 0) {
      fail('order_not_payable', 'no rail available for this amount')
    }

    return NextResponse.json({
      orderId,
      razorpayOrderId: rzp.razorpayOrderId,
      // Echoed for display only. The server already told Razorpay the amount;
      // the client cannot influence it.
      amountPaise: rzp.amountPaise,
      amountDisplay: formatINR(rzp.amountPaise),
      currency: rzp.currency,
      razorpayKeyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      rails: {
        available: rails.available,
        blocked: rails.blocked,
        preferred: rails.preferred,
        expectation: expectedGestures(rails, rails.preferred),
      },
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
