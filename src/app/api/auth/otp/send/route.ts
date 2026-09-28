import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { checkLimit, enforce, clientIp } from '@/lib/rate-limit'
import { createAndSendOtp } from '@/lib/otp'
import { audit, alertOn } from '@/lib/audit'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { requireApiKey } from '@/lib/api-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * OTP fallback — send a code.
 *
 * This is the single most abuse-sensitive endpoint in the app: every send can
 * cost real money at a provider, so it carries three overlapping limits from
 * day one (rate-limit.ts): per identifier, per IP, and a global ceiling that
 * pages someone rather than just 429-ing. All three must pass.
 *
 * Requires a signed-in user — the merchant-side fallback verifies a contact for
 * someone we already know. (Anonymous sign-in-time codes are Clerk's own
 * email/phone factor, configured in the Clerk dashboard.)
 */
const Body = z.object({
  identifier: z.string().min(3).max(254),
  purpose: z.enum(['verify', 'fallback_signin']).optional(),
})

export async function POST(request: Request) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    const session = await requireUser()
    const ip = clientIp(request.headers)

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) fail('invalid_request', parsed.error.message)
    const { identifier } = parsed.data
    const purpose = parsed.data.purpose ?? 'verify'

    // Global ceiling first, and alert the moment it trips — a global spike is a
    // toll-fraud / SMS-pumping attack in progress, not one noisy user.
    const global = await checkLimit('otpGlobal', 'all')
    if (!global.allowed) {
      alertOn('otp_fallback', {
        reason: 'global_ceiling_tripped',
        ip,
        userId: session.userId,
        requestId,
      })
      fail('rate_limited', 'otp global ceiling')
    }

    await enforce('otpPerIp', ip)
    await enforce('otpPerIdentifier', identifier)

    const result = await createAndSendOtp({
      identifier,
      userId: session.userId,
      purpose,
    })

    await audit({
      event: 'otp_fallback',
      outcome: 'success',
      userId: session.userId,
      ip,
      detail: { action: 'send', purpose, delivered: result.delivered },
    })

    return NextResponse.json({
      sent: true,
      // In production this is always true; in dev the code is in the server log.
      delivered: result.delivered,
      expiresAt: result.expiresAt,
      ttlSeconds: result.ttlSeconds,
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
