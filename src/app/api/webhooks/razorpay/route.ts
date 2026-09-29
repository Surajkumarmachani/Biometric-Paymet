import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { sql, jsonb } from '@/lib/db'
import { serverEnv } from '@/env'
import { verifyWebhookSignature } from '@/lib/razorpay/verify'
import { alertOn } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Razorpay's documented delivery semantics, every one of which constrains this
 * handler:
 *
 *   * respond 2xx within FIVE SECONDS — slow is treated as failure and resent
 *   * retries with exponential backoff for 24 HOURS, then the webhook is
 *     AUTO-DISABLED (and you will not be told loudly)
 *   * "at-least-once delivery semantics" — duplicates are guaranteed
 *   * "You may not always receive the webhooks in order"
 *   * signature is HMAC-SHA256 over the RAW body with the WEBHOOK secret
 *     (not key_secret): "Do not parse or cast the webhook request body"
 *
 * Therefore: verify -> dedupe -> enqueue -> 200. Never verify -> business logic
 * -> 200. The drain (/api/internal/drain) does the work out of band.
 */
export async function POST(request: Request) {
  // RAW body, read exactly ONCE.
  //
  // The App Router needs no bodyParser config (that was a Pages Router thing).
  // The subtler trap: never request.json() then JSON.stringify() to verify —
  // key order and whitespace do not round-trip and the HMAC fails intermittently.
  const raw = await request.text()

  const signature = request.headers.get('x-razorpay-signature')
  const eventId = request.headers.get('x-razorpay-event-id')

  // Guard BOTH headers before touching the database. A missing event id would
  // otherwise be a NOT NULL violation (23502) -> 500 -> 24h of retries ->
  // auto-disabled webhook.
  if (!signature || !eventId) {
    return new NextResponse('missing signature or event id', { status: 400 })
  }

  const env = serverEnv()
  const valid = verifyWebhookSignature({
    rawBody: raw,
    signature,
    // Dual verification so a webhook-secret rotation does not drop in-flight
    // events. Keep PREVIOUS set only during the overlap window.
    secrets: [env.RAZORPAY_WEBHOOK_SECRET, env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS],
  })

  if (!valid) {
    alertOn('webhook_rejected', { reason: 'invalid signature', eventId })
    return new NextResponse('invalid signature', { status: 400 })
  }

  let event: { event?: string; created_at?: number }
  try {
    event = JSON.parse(raw) // parse the SAME string we verified
  } catch {
    return new NextResponse('malformed json', { status: 400 })
  }

  // Store the PARSED object via jsonb(), not the raw string.
  //
  // `${raw}::jsonb` would store a jsonb *string* rather than an object (see
  // jsonb() in lib/db.ts), so the drain's payload.payload.payment.entity.id
  // lookup would find nothing and no order would ever be fulfilled. The raw
  // text was only ever needed for the signature check, which is already done.

  if (!event.event || typeof event.created_at !== 'number') {
    return new NextResponse('unexpected payload shape', { status: 400 })
  }

  // Razorpay retries for 24 hours and then gives up, so a correctly signed body
  // much older than that is not a retry — it is someone replaying one they
  // kept. Acknowledge (so nothing retries) and drop it.
  const ageHours = (Date.now() / 1000 - event.created_at) / 3600
  if (ageHours > webhookMaxAgeHours()) {
    alertOn('webhook_rejected', { reason: 'stale event', eventId, ageHours: Math.round(ageHours) })
    return new NextResponse('ok (stale, ignored)', { status: 200 })
  }

  // The event-id header is NOT covered by the signature, so it cannot be the
  // only dedupe key: the same signed bytes under a new id would process twice.
  // One ledger row per signed body closes that; a genuine redelivery carries
  // the same body AND id, and either unique key reports it as a duplicate.
  const bodySha256 = createHash('sha256').update(raw, 'utf8').digest('hex')

  try {
    await sql`
      insert into razorpay_webhook_events
        (event_id, event_type, razorpay_created_at, payload, status, body_sha256)
      values (
        ${eventId},
        ${event.event},
        ${new Date(event.created_at * 1000).toISOString()},
        ${jsonb(event)}::jsonb,
        'pending',
        ${bodySha256}
      )
    `
  } catch (err) {
    // 23505 = unique violation = Razorpay redelivered. That is expected and
    // correct; acknowledge it so they stop retrying.
    if ((err as { code?: string }).code === '23505') {
      return new NextResponse('ok (duplicate)', { status: 200 })
    }
    // A real storage failure must NOT be acknowledged — let Razorpay retry.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'webhook_persist_failed',
        eventId,
        detail: err instanceof Error ? err.message : String(err),
      }),
    )
    return new NextResponse('storage error', { status: 500 })
  }

  // Inside the 5s budget, with no business logic attempted.
  return new NextResponse('ok', { status: 200 })
}

/** Oldest signed event we will still ledger. Default 72h: Razorpay's 24h retry window plus slack. */
function webhookMaxAgeHours(): number {
  const n = Number(process.env.WEBHOOK_MAX_AGE_HOURS)
  return Number.isFinite(n) && n > 0 ? n : 72
}
