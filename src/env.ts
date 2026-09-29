import 'server-only'
import { z } from 'zod'

/**
 * Server-side environment. Validated lazily so that a test or a script that
 * only needs the database does not have to invent Razorpay credentials.
 *
 * Nothing in here may be imported from a Client Component. `server-only` makes
 * that a build error rather than a silent secret leak.
 */

/**
 * An optional secret. A `.env` file commonly ships the key present-but-empty
 * (e.g. `RAZORPAY_WEBHOOK_SECRET_PREVIOUS=`), and Next loads that as "" — which
 * `.min(1).optional()` would reject. Treat empty as absent so the shipped
 * defaults validate; a real value still has to be non-trivial.
 */
const optionalSecret = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
)

const schema = z.object({
  DATABASE_URL: z.string().url(),

  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,

  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),
  /** Set only during a webhook-secret rotation overlap window. */
  RAZORPAY_WEBHOOK_SECRET_PREVIOUS: optionalSecret,

  /**
   * DORMANT (Option B, Sprint 6). Optional because nothing reads them today —
   * Clerk owns the WebAuthn ceremony, so we never verify an assertion and never
   * need our own rp.id or origin allowlist. Leave them unset until an
   * own-credential ceremony exists; `allowedOrigins()` below throws rather than
   * guess, which is the correct behaviour for a security-relevant allowlist.
   */
  WEBAUTHN_RP_ID: optionalSecret,
  WEBAUTHN_RP_NAME: optionalSecret,
  WEBAUTHN_ALLOWED_ORIGINS: optionalSecret,

  MERCHANT_MCC: z.string().default('5944'),
  INTERNAL_TASK_SECRET: z.string().min(32),
})

export type ServerEnv = z.infer<typeof schema>

let cached: ServerEnv | null = null

export function serverEnv(): ServerEnv {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Invalid or missing server environment: ${missing}`)
  }
  cached = parsed.data
  return cached
}

/** Only the DB URL, for scripts and tests. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  return url
}

/**
 * Every origin a WebAuthn ceremony may legitimately come from. Verification
 * compares clientDataJSON.origin against this list; a missing entry is the
 * classic "works on desktop, fails on the QR subdomain" bug.
 *
 * DORMANT (Option B, Sprint 6): no caller today, because we never see a
 * clientDataJSON to check. Throwing on a missing allowlist is deliberate —
 * an origin check that silently accepts everything is worse than no route.
 */
export function allowedOrigins(): string[] {
  const raw = process.env.WEBAUTHN_ALLOWED_ORIGINS
  if (!raw) throw new Error('WEBAUTHN_ALLOWED_ORIGINS is not set')
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
