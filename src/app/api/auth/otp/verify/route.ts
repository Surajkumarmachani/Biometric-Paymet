import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { enforce, clientIp } from '@/lib/rate-limit'
import { verifyOtp } from '@/lib/otp'
import { audit } from '@/lib/audit'
import { errorResponse, newRequestId, fail } from '@/lib/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * OTP fallback — verify a code.
 *
 * Brute force is bounded in two places: the per-challenge attempt cap in
 * app.verify_otp_challenge (burns the code after 5 tries) and a per-IP limit
 * here. A wrong code returns 200 with {verified:false} + remaining attempts so
 * the UI can guide the customer; only exhausted/expired codes and rate limits
 * are hard failures.
 */
const Body = z.object({
  identifier: z.string().min(3).max(254),
  code: z.string().regex(/^\d{6}$/),
  purpose: z.enum(['verify', 'fallback_signin']).optional(),
})

export async function POST(request: Request) {
  const requestId = newRequestId()
  try {
    const session = await requireUser()
    const ip = clientIp(request.headers)
    await enforce('otpPerIp', ip)

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) fail('invalid_request', parsed.error.message)
    const { identifier, code } = parsed.data
    const purpose = parsed.data.purpose ?? 'verify'

    const result = await verifyOtp({ identifier, code, purpose })

    await audit({
      event: 'otp_fallback',
      outcome: result.ok ? 'success' : 'failure',
      userId: session.userId,
      ip,
      detail: { action: 'verify', purpose, reason: result.reason ?? null },
    })

    return NextResponse.json({
      verified: result.ok,
      reason: result.ok ? undefined : result.reason,
      remaining: result.remaining,
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
