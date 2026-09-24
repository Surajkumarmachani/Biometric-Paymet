import { NextResponse } from 'next/server'
import { assertInternalSecret } from '@/lib/auth'
import { sql, rpc } from '@/lib/db'
import { errorResponse, newRequestId } from '@/lib/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Housekeeping. Schedule daily (vercel.json, 03:17).
 *
 * Purges expired challenges and stale rate-limit buckets, plus the three that
 * matter for DPDP purpose limitation rather than for disk:
 *
 *   * processed webhook payloads past `purge_after` — they carry email, contact
 *     and card last4
 *   * consumed/expired OTP challenges — `identifier` IS an email or phone
 *   * auth_audit_log past the retention window — it carries `ip` and
 *     `user_agent` on every attempt
 *
 * The last two only started working in 0011_retention.sql; before that
 * app.sweep_otp() was never called by anything and the audit log had no
 * retention at all. Rows belonging to a disputed order are exempt — read the
 * comment in 0011 before changing the window.
 */
async function run(request: Request) {
  const requestId = newRequestId()
  try {
    assertInternalSecret(
      request.headers.get('x-internal-secret') ??
        request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
        null,
    )
    const report = await rpc<Record<string, number>>(sql`select app.sweep()`)
    return NextResponse.json({ ...report, requestId })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}

export const GET = run
export const POST = run
