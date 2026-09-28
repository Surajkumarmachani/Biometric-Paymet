import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, type TestDb } from '../setup/pg'
import { generateApiKey, hashApiKey, displayPrefix } from '../../src/lib/api-key-format'

/**
 * Gate: per-client API keys.
 *
 *   * only the hash is stored — the plaintext key appears nowhere in the row
 *   * unknown and revoked keys are indistinguishable ('invalid')
 *   * every accepted request is counted and stamps last_used_at
 *   * the per-minute limit trips at limit+1 with a sane retry_after, and a
 *     per-key override beats the default
 * All enforced in app.api_key_hit — one round trip per request.
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('api_keys') })
afterAll(async () => { await db?.drop() })

async function makeKey(name: string, limit: number | null = null) {
  const key = generateApiKey()
  const [row] = await db.sql`
    insert into api_keys (name, key_hash, key_prefix, rate_limit_per_min)
    values (${name}, ${hashApiKey(key)}, ${displayPrefix(key)}, ${limit})
    returning id`
  return { key, id: row!.id as string }
}
const hit = async (key: string, defaultLimit = 100) =>
  one<{ ok: boolean; reason?: string; retry_after?: number; id?: string; name?: string }>(
    await db.sql`select app.api_key_hit(${hashApiKey(key)}, ${defaultLimit})`,
  )

describe('api keys', () => {
  it('accepts a valid key and names the client', async () => {
    const { key, id } = await makeKey('Desktop till')
    const out = await hit(key)
    expect(out).toMatchObject({ ok: true, id, name: 'Desktop till' })
  })

  it('never stores the plaintext key', async () => {
    const { key, id } = await makeKey('Hash only')
    const [row] = await db.sql`select row_to_json(k)::text as j from api_keys k where id = ${id}`
    expect(row!.j).not.toContain(key.slice(4))
  })

  it('rejects an unknown key', async () => {
    expect(await hit(generateApiKey())).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a revoked key exactly like an unknown one', async () => {
    const { key, id } = await makeKey('Revoked')
    expect((await hit(key)).ok).toBe(true)
    await db.sql`update api_keys set active = false, revoked_at = now() where id = ${id}`
    expect(await hit(key)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('counts requests and stamps last_used_at', async () => {
    const { key, id } = await makeKey('Counter')
    for (let i = 0; i < 3; i++) await hit(key)
    const [row] = await db.sql`select request_count, last_used_at from api_keys where id = ${id}`
    expect(Number(row!.request_count)).toBe(3)
    expect(row!.last_used_at).not.toBeNull()
  })

  it('rate-limits at default+1 with a retry_after inside the window', async () => {
    const { key } = await makeKey('Limited')
    for (let i = 0; i < 3; i++) expect((await hit(key, 3)).ok).toBe(true)
    const out = await hit(key, 3)
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('rate_limited')
    expect(out.retry_after).toBeGreaterThanOrEqual(1)
    expect(out.retry_after).toBeLessThanOrEqual(60)
  })

  it('lets a per-key override beat the default', async () => {
    const { key } = await makeKey('Web frontend', 5)
    for (let i = 0; i < 5; i++) expect((await hit(key, 2)).ok).toBe(true)
    expect((await hit(key, 2)).reason).toBe('rate_limited')
  })

  it('opens a fresh window once the old one has passed', async () => {
    const { key, id } = await makeKey('Window')
    await hit(key, 1)
    expect((await hit(key, 1)).reason).toBe('rate_limited')
    await db.sql`update api_keys set window_start = now() - interval '61 seconds' where id = ${id}`
    expect((await hit(key, 1)).ok).toBe(true)
  })
})
