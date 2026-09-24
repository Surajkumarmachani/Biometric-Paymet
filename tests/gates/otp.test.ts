import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import { createTestDb, one, type TestDb } from '../setup/pg'

/**
 * Gate: OTP fallback (S2 Identity).
 *
 * The properties that make a code fallback safe rather than a liability:
 *   * consumption is single-use and atomic (no replay)
 *   * wrong codes are attempt-capped, then the code is burned (no brute force)
 *   * a freshly sent code invalidates the previous one (no stale valid codes)
 *   * an expired code never verifies
 * All enforced in app.verify_otp_challenge — application code cannot skip them.
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('otp') })
afterAll(async () => { await db?.drop() })

const hash = (id: string, code: string) =>
  crypto.createHash('sha256').update(`${id}:${code}`).digest('hex')

async function create(id: string, code: string, opts?: { ttl?: number; max?: number; user?: string }) {
  return one(
    await db.sql`select app.create_otp_challenge(
      ${id}, ${hash(id, code)}, ${opts?.user ?? null},
      ${'verify'}, ${opts?.ttl ?? 300}, ${opts?.max ?? 5})`,
  )
}
async function verify(id: string, code: string) {
  return one<{ ok: boolean; reason?: string; remaining?: number; user_id?: string | null }>(
    await db.sql`select app.verify_otp_challenge(${id}, ${'verify'}, ${hash(id, code)})`,
  )
}

describe('otp verification', () => {
  it('verifies a correct code and returns the bound user', async () => {
    const id = 'u1@example.com'
    await create(id, '111111', { user: 'user_u1' })
    const out = await verify(id, '111111')
    expect(out.ok).toBe(true)
    expect(out.user_id).toBe('user_u1')
  })

  it('is single-use — a correct code cannot be replayed', async () => {
    const id = 'u2@example.com'
    await create(id, '222222')
    expect((await verify(id, '222222')).ok).toBe(true)
    const replay = await verify(id, '222222')
    expect(replay.ok).toBe(false)
    expect(replay.reason).toBe('no_active')
  })

  it('counts wrong attempts and reports the remaining budget', async () => {
    const id = 'u3@example.com'
    await create(id, '333333', { max: 5 })
    const first = await verify(id, '000000')
    expect(first.ok).toBe(false)
    expect(first.reason).toBe('mismatch')
    expect(first.remaining).toBe(4)
  })

  it('burns the code after the attempt cap — no brute force', async () => {
    const id = 'u4@example.com'
    await create(id, '444444', { max: 3 })
    await verify(id, '000000') // 1
    await verify(id, '000001') // 2
    await verify(id, '000002') // 3 -> cap reached, burned
    // Even the CORRECT code no longer works.
    const afterCap = await verify(id, '444444')
    expect(afterCap.ok).toBe(false)
    expect(['too_many_attempts', 'no_active']).toContain(afterCap.reason)
  })

  it('a freshly created code invalidates the previous one', async () => {
    const id = 'u5@example.com'
    await create(id, '555555')
    await create(id, '666666') // supersedes
    expect((await verify(id, '555555')).ok).toBe(false)
    expect((await verify(id, '666666')).ok).toBe(true)
  })

  it('never verifies an expired code', async () => {
    const id = 'u6@example.com'
    await create(id, '777777', { ttl: -1 }) // already expired
    const out = await verify(id, '777777')
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('no_active')
  })
})
