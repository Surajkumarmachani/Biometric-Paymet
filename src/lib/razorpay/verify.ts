import 'server-only'
import crypto from 'node:crypto'

/**
 * The two HMACs. They use DIFFERENT secrets and DIFFERENT messages, and mixing
 * them up is the most common Razorpay integration bug.
 *
 *   Browser callback : HMAC-SHA256(`${order_id}|${payment_id}`, KEY_SECRET)
 *   Webhook          : HMAC-SHA256(rawBody,                     WEBHOOK_SECRET)
 *
 * Both are hex, lowercase. Razorpay's own SDK compares with `===`; we use
 * timingSafeEqual. `validatePaymentVerification` is NOT a static on the
 * Razorpay class (only `validateWebhookSignature` is), so we do this with
 * node:crypto rather than deep-importing into the SDK's dist/.
 */

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Verify the signature returned to the browser by Standard Checkout.
 *
 * Every parameter is optional in the type because they arrive from a request
 * body. `Buffer.from(undefined)` throws, so the guard has to come before any
 * crypto — otherwise a malformed callback is a 500, not a 400.
 *
 * Proving this signature does NOT mean the payment succeeded. It proves the
 * values were not tampered with in the browser. Always follow with
 * GET /v1/payments/:id and require status === 'captured'.
 */
export function verifyCheckoutSignature(params: {
  orderId?: string | null
  paymentId?: string | null
  signature?: string | null
  keySecret?: string | null
}): boolean {
  const { orderId, paymentId, signature, keySecret } = params
  if (!orderId || !paymentId || !signature || !keySecret) return false
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false

  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`) // order_id FIRST, pipe-separated
    .digest('hex')

  return safeEqualHex(expected, signature)
}

/**
 * Verify a webhook against the raw, unmodified body.
 *
 * `secrets` accepts more than one so a webhook-secret rotation can run with
 * dual verification: put the new secret first and keep the previous one until
 * the overlap window closes. Without this, rotating the secret drops every
 * in-flight event, and 24h of failures auto-disables the webhook.
 */
export function verifyWebhookSignature(params: {
  rawBody: string
  signature?: string | null
  secrets: Array<string | undefined | null>
}): boolean {
  const { rawBody, signature } = params
  if (!signature) return false
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false

  const secrets = params.secrets.filter((s): s is string => Boolean(s))
  if (secrets.length === 0) return false

  // Compute against every active secret; do not early-return on the first
  // mismatch in a way that leaks which secret matched.
  let ok = false
  for (const secret of secrets) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
    if (safeEqualHex(expected, signature)) ok = true
  }
  return ok
}

/** sha256 hex of a QR claim token. Only the hash is ever stored. */
export function hashClaimToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 32 bytes, base64url. Used for claim tokens and WebAuthn challenges. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}
