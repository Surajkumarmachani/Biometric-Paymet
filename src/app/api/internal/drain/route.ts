import { NextResponse } from 'next/server'
import { assertInternalSecret } from '@/lib/auth'
import { drainWebhooks } from '@/lib/drain'
import { errorResponse, newRequestId } from '@/lib/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Webhook ledger drain. Schedule every minute:
 *
 *   vercel.json
 *   { "crons": [{ "path": "/api/internal/drain", "schedule": "* * * * *" }] }
 *
 * Vercel Cron sends GET, so both verbs are accepted. Authorise with
 * x-internal-secret; Vercel Cron can also be verified via its own
 * Authorization: Bearer $CRON_SECRET header if you prefer.
 *
 * Alternatives if you would rather not use Vercel Cron: a Supabase Scheduled
 * Edge Function, or pg_cron PLUS pg_net (plain pg_cron cannot make HTTP calls).
 */
async function run(request: Request) {
  const requestId = newRequestId()
  try {
    assertInternalSecret(
      request.headers.get('x-internal-secret') ??
        request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
        null,
    )
    const report = await drainWebhooks(25)
    return NextResponse.json({ ...report, requestId })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}

export const GET = run
export const POST = run
