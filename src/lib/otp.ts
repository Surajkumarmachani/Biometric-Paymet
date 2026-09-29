import 'server-only'
import crypto from 'node:crypto'
import { sql, rpc } from './db'
import { maskIdentifier, scrubPII } from './redact'

/**
 * OTP fallback (S2 Identity).
 *
 * A one-time numeric code sent to a customer's verified contact when their
 * device cannot do passkeys. It authenticates the customer to US; it is NOT a
 * payment authorization factor — see 0004_otp.sql and threat 19.
 *
 * The code is generated and hashed here; only the sha256 lands in the database
 * (via app.create_otp_challenge). Delivery goes through a pluggable sender so a
 * real SMS/email provider drops in without touching the verify path. With no
 * provider configured (local dev), the code is logged, never returned to the
 * caller.
 *
 * WHY THIS EXISTS ALONGSIDE CLERK'S OWN EMAIL/SMS CODES
 *
 * Clerk already does OTP, and it owns SIGN-IN — including the no-passkey path.
 * This module deliberately does not compete with that. Both routes that use it
 * (/api/auth/otp/send, /api/auth/otp/verify) call requireUser() first, so the
 * caller is ALREADY signed in. What it provides is a contact-point challenge we
 * own end to end:
 *
 *   * an in-app "prove you hold this email/phone" step on /account/security,
 *     for a device that has no passkey and for recovery-contact confirmation
 *   * OUR rate limits (per identifier, per IP, global ceiling) and OUR audit
 *     rows in auth_audit_log, which dispute evidence needs and which a code
 *     sent inside Clerk's own flow would not produce
 *
 * The `fallback_signin` purpose is therefore ASPIRATIONAL, not reachable: a
 * signed-in caller cannot use it to sign in. It stays in the enum because
 * 0004_otp.sql keys the one-active-code index on (identifier, purpose) and a
 * future device-binding flow wants its own bucket — but do not read it as a
 * shipped capability. If you need a genuine no-passkey sign-in, configure it in
 * Clerk; do not build it here.
 */

export type OtpPurpose = 'verify' | 'fallback_signin'

/** 6-digit numeric, uniform over 000000..999999 (crypto, not Math.random). */
function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Salt the hash with the identifier so a code is only valid for its target. */
function hashCode(identifier: string, code: string): string {
  return crypto.createHash('sha256').update(`${identifier}:${code}`).digest('hex')
}

type Channel = 'email' | 'sms'

/**
 * One canonical spelling per contact, or null if it is not a contact we send to.
 *
 * Everything downstream keys on this string — the per-identifier rate-limit
 * bucket, the challenge row, the code hash — so two spellings of one number
 * ("+91 98…", "+9198…", "98…") used to be three buckets, and a pumping loop
 * could walk the formatting to dodge otpPerIdentifier.
 *
 *   * email — trimmed and lower-cased
 *   * phone — separators stripped, E.164. A bare 10-digit Indian mobile
 *     (starts 6-9) gets +91; any other number must carry its own +country.
 */
export function normalizeIdentifier(raw: string): { identifier: string; channel: Channel } | null {
  const s = raw.trim()
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return { identifier: s.toLowerCase(), channel: 'email' }
  const digits = s.replace(/[\s\-().]/g, '')
  if (/^[6-9][0-9]{9}$/.test(digits)) return { identifier: `+91${digits}`, channel: 'sms' }
  if (/^\+[1-9][0-9]{7,14}$/.test(digits)) return { identifier: digits, channel: 'sms' }
  return null
}

/**
 * Country codes we will text. SMS pumping (toll fraud) makes its money on
 * premium-rate international numbers, so a verification SMS only goes to
 * countries the business actually serves. Comma list, default India.
 */
export function smsAllowed(e164: string): boolean {
  const prefixes = (process.env.OTP_SMS_ALLOWED_PREFIXES ?? '+91')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  return prefixes.some((p) => e164.startsWith(p))
}

/** Email via Resend (https://resend.com). Returns false if not configured. */
async function sendEmail(to: string, code: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY
  const from = process.env.OTP_EMAIL_FROM
  if (!key || !from) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      subject: `Your REGAL LAB code: ${code}`,
      html: `<p style="font:16px/1.5 system-ui,sans-serif">Your REGAL LAB verification code is <strong style="font-size:22px;letter-spacing:2px">${code}</strong>.<br>It expires in 5 minutes. If you didn’t request this, ignore this email.</p>`,
    }),
  })
  if (!res.ok) {
    console.error(JSON.stringify({ level: 'error', event: 'otp_email_failed', status: res.status, detail: scrubPII((await res.text()).slice(0, 200)) }))
    return false
  }
  return true
}

/** SMS via Twilio. Returns false if not configured. `to` must be E.164 (+91…). */
async function sendSms(to: string, code: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_FROM
  if (!sid || !token || !from) return false
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      To: to,
      From: from,
      Body: `${code} is your REGAL LAB verification code. It expires in 5 minutes.`,
    }).toString(),
  })
  if (!res.ok) {
    console.error(JSON.stringify({ level: 'error', event: 'otp_sms_failed', status: res.status, detail: scrubPII((await res.text()).slice(0, 200)) }))
    return false
  }
  return true
}

/**
 * Deliver the code to the right channel based on the identifier.
 *
 * Returns whether a real provider dispatched it. If no provider is configured
 * (or a send fails), we fall back to logging the code IN DEVELOPMENT ONLY — a
 * production log must never contain a live OTP, so there we log a failure
 * without the code.
 */
async function sendCode(identifier: string, code: string, purpose: OtpPurpose): Promise<boolean> {
  const channel = normalizeIdentifier(identifier)?.channel ?? 'unknown'
  try {
    if (channel === 'email' && (await sendEmail(identifier, code))) return true
    if (channel === 'sms' && (await sendSms(identifier, code))) return true
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', event: 'otp_delivery_error', channel, detail: scrubPII(err instanceof Error ? err.message : String(err)) }))
  }

  if (mayLogCodes()) {
    console.log(JSON.stringify({ level: 'info', event: 'otp_dev_delivery', note: `channel=${channel}, no provider configured or send failed — code logged for local testing only`, identifier, purpose, code }))
  } else {
    console.error(JSON.stringify({ level: 'error', event: 'otp_delivery_unconfigured', channel, identifier: maskIdentifier(identifier), purpose }))
  }
  return false
}

/**
 * Whether an undelivered code may be printed to the log. Only on a developer's
 * machine: NODE_ENV exactly 'development' (next dev) or 'test'. It used to be
 * "anything but production", so a container started with NODE_ENV=staging —
 * or with it unset — wrote live codes into Cloud Logging.
 */
export function mayLogCodes(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test'
}

export interface OtpSendResult {
  expiresAt: string
  /** true once a real provider is wired; false = code is in the server log. */
  delivered: boolean
  ttlSeconds: number
}

export async function createAndSendOtp(args: {
  identifier: string
  userId?: string | null
  purpose?: OtpPurpose
  ttlSeconds?: number
}): Promise<OtpSendResult> {
  const purpose = args.purpose ?? 'verify'
  const ttlSeconds = args.ttlSeconds ?? 300
  const code = generateCode()
  const codeHash = hashCode(args.identifier, code)

  const out = await rpc<{ id: string; expires_at: string }>(sql`
    select app.create_otp_challenge(
      ${args.identifier},
      ${codeHash},
      ${args.userId ?? null},
      ${purpose},
      ${ttlSeconds},
      5
    )
  `)

  const delivered = await sendCode(args.identifier, code, purpose)
  return { expiresAt: out.expires_at, delivered, ttlSeconds }
}

export type OtpVerifyReason = 'no_active' | 'too_many_attempts' | 'mismatch'

export interface OtpVerifyResult {
  ok: boolean
  reason?: OtpVerifyReason
  remaining?: number
  userId?: string | null
}

export async function verifyOtp(args: {
  identifier: string
  code: string
  /** The signed-in caller. Only their own challenge can match (0016). */
  userId: string
  purpose?: OtpPurpose
}): Promise<OtpVerifyResult> {
  const purpose = args.purpose ?? 'verify'
  const codeHash = hashCode(args.identifier, args.code)

  const out = await rpc<{
    ok: boolean
    reason?: OtpVerifyReason
    remaining?: number
    user_id?: string | null
  }>(sql`
    select app.verify_otp_challenge(${args.identifier}, ${purpose}, ${codeHash}, ${args.userId})
  `)

  return {
    ok: out.ok,
    reason: out.reason,
    remaining: out.remaining,
    userId: out.user_id ?? null,
  }
}
