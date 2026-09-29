import 'server-only'
import { timingSafeEqual, createHash } from 'node:crypto'
import { sql, rpc } from './db'
import { ApiError, fail } from './errors'
import { enforce, clientIp } from './rate-limit'
import { generateApiKey, hashApiKey, displayPrefix } from './api-key-format'

/**
 * Per-client API keys.
 *
 * A key answers "which application is calling" (desktop till, website, a
 * customer's integration) and meters it. It does NOT answer "which person" —
 * that is still Clerk, and money still moves only behind a passkey step-up.
 *
 * Every /api route calls requireApiKey() first, except the ones a key cannot
 * reach by construction: the Razorpay webhook (Razorpay cannot send our header;
 * it is HMAC-verified instead), the cron routes (INTERNAL_TASK_SECRET), the
 * admin routes (ADMIN_TOKEN — you need them to mint the first key) and
 * /api/health. tests/unit/api-key-coverage.test.ts fails the build if a new
 * route forgets.
 */

export interface ApiClient {
  id: string
  name: string
}

/** Requests per minute per key when the key row has no override. */
export function defaultRateLimit(): number {
  const n = Number(process.env.RATE_LIMIT_PER_MIN ?? 300)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300
}

export async function requireApiKey(request: Request): Promise<ApiClient> {
  const key = request.headers.get('x-api-key')?.trim()
  if (!key) fail('invalid_api_key', 'no X-API-Key header')

  const out = await rpc<{
    ok: boolean
    reason?: 'invalid' | 'rate_limited'
    retry_after?: number
    id?: string
    name?: string
  }>(sql`select app.api_key_hit(${hashApiKey(key)}, ${defaultRateLimit()})`)

  if (out.ok) return { id: out.id!, name: out.name! }
  if (out.reason === 'rate_limited') {
    throw new ApiError('rate_limited', `api key rate limit (${displayPrefix(key)})`, out.retry_after)
  }
  fail('invalid_api_key', `unknown or revoked key ${displayPrefix(key)}`)
}

/**
 * Admin routes. Disabled entirely (404, as if the route did not exist) when
 * ADMIN_TOKEN is unset, so a deployment that never configured one has no admin
 * surface at all. Attempts are rate-limited per IP before the compare, so a
 * wrong-token loop cannot run unbounded.
 */
export async function requireAdmin(request: Request): Promise<void> {
  const expected = process.env.ADMIN_TOKEN
  if (!expected) fail('not_found', 'admin disabled: ADMIN_TOKEN unset')

  await enforce('adminPerIp', clientIp(request.headers))
  await enforce('adminGlobal', 'all')

  const given = request.headers.get('x-admin-token') ?? ''
  // Compare digests so the lengths always match and timingSafeEqual cannot throw.
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  if (!given || !timingSafeEqual(a, b)) fail('forbidden', 'bad admin token')
}

export interface ApiKeyRow {
  id: string
  name: string
  keyPrefix: string
  active: boolean
  rateLimitPerMin: number | null
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  requestCount: number
}

type DbRow = {
  id: string
  name: string
  key_prefix: string
  active: boolean
  rate_limit_per_min: number | null
  created_at: Date
  last_used_at: Date | null
  revoked_at: Date | null
  request_count: string
}

function toRow(r: DbRow): ApiKeyRow {
  return {
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    active: r.active,
    rateLimitPerMin: r.rate_limit_per_min,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    requestCount: Number(r.request_count),
  }
}

/** Creates a key. The plaintext is in the return value and nowhere else, ever. */
export async function createApiKey(
  name: string,
  rateLimitPerMin?: number | null,
): Promise<{ key: string; row: ApiKeyRow }> {
  const key = generateApiKey()
  const rows = (await sql`
    insert into api_keys (name, key_hash, key_prefix, rate_limit_per_min)
    values (${name}, ${hashApiKey(key)}, ${displayPrefix(key)}, ${rateLimitPerMin ?? null})
    returning *
  `) as unknown as DbRow[]
  return { key, row: toRow(rows[0]!) }
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  const rows = (await sql`
    select * from api_keys order by created_at desc
  `) as unknown as DbRow[]
  return rows.map(toRow)
}

/** Idempotent: revoking a revoked key is a no-op that still returns it. */
export async function revokeApiKey(id: string): Promise<ApiKeyRow | null> {
  const rows = (await sql`
    update api_keys
       set active = false, revoked_at = coalesce(revoked_at, now())
     where id = ${id}::uuid
    returning *
  `) as unknown as DbRow[]
  return rows[0] ? toRow(rows[0]) : null
}
