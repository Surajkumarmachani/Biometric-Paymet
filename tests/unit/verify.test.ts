import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import {
  verifyCheckoutSignature,
  verifyWebhookSignature,
  hashClaimToken,
  randomToken,
} from '@/lib/razorpay/verify'

/**
 * The two HMACs. They use DIFFERENT secrets and DIFFERENT messages, and
 * confusing them is the most common Razorpay integration bug — so these tests
 * assert that each one REJECTS the other's construction.
 */

const KEY_SECRET = 'key_secret_abcdefghijklmnop'
const WEBHOOK_SECRET = 'webhook_secret_qrstuvwxyz'

function hmac(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('hex')
}

describe('verifyCheckoutSignature', () => {
  const orderId = 'order_ABC123'
  const paymentId = 'pay_XYZ789'
  const good = hmac(KEY_SECRET, `${orderId}|${paymentId}`)

  it('accepts a correct signature', () => {
    expect(
      verifyCheckoutSignature({ orderId, paymentId, signature: good, keySecret: KEY_SECRET }),
    ).toBe(true)
  })

  it('is order_id FIRST — the reversed order must fail', () => {
    const reversed = hmac(KEY_SECRET, `${paymentId}|${orderId}`)
    expect(
      verifyCheckoutSignature({ orderId, paymentId, signature: reversed, keySecret: KEY_SECRET }),
    ).toBe(false)
  })

  it('rejects the WEBHOOK secret', () => {
    const wrong = hmac(WEBHOOK_SECRET, `${orderId}|${paymentId}`)
    expect(
      verifyCheckoutSignature({ orderId, paymentId, signature: wrong, keySecret: KEY_SECRET }),
    ).toBe(false)
  })

  it('rejects a tampered payment id', () => {
    expect(
      verifyCheckoutSignature({
        orderId,
        paymentId: 'pay_TAMPERED',
        signature: good,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false)
  })

  it('rejects a tampered order id', () => {
    expect(
      verifyCheckoutSignature({
        orderId: 'order_TAMPERED',
        paymentId,
        signature: good,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false)
  })

  it('rejects a missing field WITHOUT throwing', () => {
    // Buffer.from(undefined) throws, which would turn a malformed callback into
    // a 500 instead of a 400. The guard must come before any crypto.
    for (const bad of [
      { orderId: undefined, paymentId, signature: good, keySecret: KEY_SECRET },
      { orderId, paymentId: undefined, signature: good, keySecret: KEY_SECRET },
      { orderId, paymentId, signature: undefined, keySecret: KEY_SECRET },
      { orderId, paymentId, signature: good, keySecret: undefined },
      { orderId: null, paymentId: null, signature: null, keySecret: null },
    ]) {
      expect(() => verifyCheckoutSignature(bad)).not.toThrow()
      expect(verifyCheckoutSignature(bad)).toBe(false)
    }
  })

  it('rejects a signature of the wrong shape without a length-mismatch throw', () => {
    for (const sig of ['', 'short', 'z'.repeat(64), good + 'ff']) {
      expect(() =>
        verifyCheckoutSignature({ orderId, paymentId, signature: sig, keySecret: KEY_SECRET }),
      ).not.toThrow()
      expect(
        verifyCheckoutSignature({ orderId, paymentId, signature: sig, keySecret: KEY_SECRET }),
      ).toBe(false)
    }
  })
})

describe('verifyWebhookSignature', () => {
  const raw = '{"event":"payment.captured","created_at":1755000000,"payload":{}}'
  const good = hmac(WEBHOOK_SECRET, raw)

  it('accepts a correct signature over the raw body', () => {
    expect(
      verifyWebhookSignature({ rawBody: raw, signature: good, secrets: [WEBHOOK_SECRET] }),
    ).toBe(true)
  })

  it('rejects the API key secret', () => {
    const wrong = hmac(KEY_SECRET, raw)
    expect(
      verifyWebhookSignature({ rawBody: raw, signature: wrong, secrets: [WEBHOOK_SECRET] }),
    ).toBe(false)
  })

  it('fails when the body is re-serialised — the round-trip trap', () => {
    // This is what happens if you request.json() then JSON.stringify() to
    // verify: key order and whitespace do not survive, so the HMAC breaks.
    const reserialised = JSON.stringify(JSON.parse(raw))
    const withSpaces = '{"event": "payment.captured", "created_at": 1755000000, "payload": {}}'

    expect(reserialised).not.toBe(withSpaces)
    expect(
      verifyWebhookSignature({
        rawBody: reserialised,
        signature: hmac(WEBHOOK_SECRET, withSpaces),
        secrets: [WEBHOOK_SECRET],
      }),
    ).toBe(false)
  })

  it('supports dual secrets during a rotation window', () => {
    const previous = 'old_webhook_secret_0123456789'
    const signedWithOld = hmac(previous, raw)

    // New secret only: an in-flight event signed with the old one is dropped.
    expect(
      verifyWebhookSignature({
        rawBody: raw,
        signature: signedWithOld,
        secrets: [WEBHOOK_SECRET],
      }),
    ).toBe(false)

    // Both active: it verifies. This is what stops a rotation from causing 24h
    // of failures and an auto-disabled webhook.
    expect(
      verifyWebhookSignature({
        rawBody: raw,
        signature: signedWithOld,
        secrets: [WEBHOOK_SECRET, previous],
      }),
    ).toBe(true)
  })

  it('rejects when no secret is configured', () => {
    expect(
      verifyWebhookSignature({ rawBody: raw, signature: good, secrets: [undefined, null] }),
    ).toBe(false)
  })

  it('rejects a missing signature header without throwing', () => {
    expect(() =>
      verifyWebhookSignature({ rawBody: raw, signature: null, secrets: [WEBHOOK_SECRET] }),
    ).not.toThrow()
    expect(
      verifyWebhookSignature({ rawBody: raw, signature: undefined, secrets: [WEBHOOK_SECRET] }),
    ).toBe(false)
  })

  it('rejects a body with an extra byte appended', () => {
    expect(
      verifyWebhookSignature({ rawBody: raw + ' ', signature: good, secrets: [WEBHOOK_SECRET] }),
    ).toBe(false)
  })
})

describe('claim tokens', () => {
  it('hashes deterministically and never stores plaintext', () => {
    const token = randomToken(32)
    expect(hashClaimToken(token)).toBe(hashClaimToken(token))
    expect(hashClaimToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashClaimToken(token)).not.toContain(token)
  })

  it('produces 32 bytes of entropy, url-safe', () => {
    const token = randomToken(32)
    expect(Buffer.from(token, 'base64url').length).toBe(32)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => randomToken(32)))
    expect(seen.size).toBe(500)
  })
})
