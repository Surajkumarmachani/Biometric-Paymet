import 'server-only'
import { sql } from './db'
import { fail } from './errors'
import { scrubPII } from './redact'

/**
 * Fixed-window rate limiting in Postgres.
 *
 * Postgres rather than an in-process Map because Vercel functions are ephemeral
 * isolates with no shared memory — an in-process counter is not a weak limiter,
 * it is no limiter at all.
 *
 * The single most important bucket here is OTP send. An attacker looping the
 * Clerk OTP fallback costs you real money per SMS, and that is direct cash
 * loss rather than a nuisance. It gets three overlapping limits: per
 * identifier, per IP, and a global ceiling that trips an alert.
 */

export interface Limit {
  limit: number
  windowSeconds: number
}

export const LIMITS = {
  /** Challenge creation — cheap for us, but floods the challenge table. */
  payOptionsPerUser: { limit: 20, windowSeconds: 3600 },
  payOptionsPerOrder: { limit: 5, windowSeconds: 60 },
  /** Order creation. */
  orderCreatePerUser: { limit: 20, windowSeconds: 3600 },
  staffOrderCreate: { limit: 120, windowSeconds: 3600 },
  /** QR claim-token enumeration. */
  claimPerIp: { limit: 60, windowSeconds: 60 },
  claimPerUser: { limit: 20, windowSeconds: 3600 },
  /** Confirm/poll are chatty by design; keep them loose but bounded. */
  confirmPerUser: { limit: 60, windowSeconds: 60 },
  statusPerUser: { limit: 120, windowSeconds: 60 },
  /** Refunds move money outward. Tight, and alert on approach. */
  refundPerStaff: { limit: 10, windowSeconds: 3600 },
  /**
   * Asking for a refund moves no money, so this is not a fraud limit — it stops
   * one annoyed customer from filling the staff queue. One open request per
   * order is already a schema invariant (0013), so the only way to reach this
   * is repeated request/withdraw cycles or many orders.
   */
  refundRequestPerUser: { limit: 10, windowSeconds: 3600 },
  /** OTP fallback — SMS pumping / toll fraud. */
  otpPerIdentifier: { limit: 5, windowSeconds: 3600 },
  otpPerIp: { limit: 10, windowSeconds: 3600 },
  /** One account's share of the SMS budget — the IP can rotate, the account cannot. */
  otpPerUser: { limit: 5, windowSeconds: 3600 },
  otpGlobal: { limit: 500, windowSeconds: 3600 },
  /** Admin key management. Counted before the token compare, so it bounds guessing. */
  adminPerIp: { limit: 30, windowSeconds: 60 },
  /**
   * Every admin attempt, from anywhere. A backstop for the per-IP bucket: admin
   * traffic is a person minting a key now and then, so a ceiling this low
   * costs nothing legitimate and caps total guessing even if IP bucketing is
   * ever fooled again.
   */
  adminGlobal: { limit: 120, windowSeconds: 3600 },
} as const satisfies Record<string, Limit>

export type LimitName = keyof typeof LIMITS

export async function checkLimit(
  name: LimitName,
  subject: string,
): Promise<{ allowed: boolean }> {
  const { limit, windowSeconds } = LIMITS[name]
  const bucket = `${name}:${subject}`

  const rows = (await sql`
    select app.rate_limit_hit(
      ${bucket}, ${limit}, make_interval(secs => ${windowSeconds})
    ) as allowed
  `) as unknown as Array<{ allowed: boolean }>

  return { allowed: rows[0]?.allowed === true }
}

/** Throws 429 when over the limit. */
export async function enforce(name: LimitName, subject: string): Promise<void> {
  const { allowed } = await checkLimit(name, subject)
  // The subject may be an email or phone (OTP buckets) — mask those; the
  // bucket name says what tripped, which is what the log line is for.
  if (!allowed) fail('rate_limited', `${name} exceeded for ${scrubPII(subject)}`)
}

export { clientIp } from './client-ip'
