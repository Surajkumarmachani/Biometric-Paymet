import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import { createTestDb, one, ALICE, idem, type TestDb } from '../setup/pg'

/**
 * Gate: RETENTION (0011).
 *
 * The daily sweep is the only thing standing between this app and keeping
 * personal data forever. Two of its jobs were missing entirely before 0011:
 * app.sweep_otp() was defined but never called from anywhere, and
 * auth_audit_log had no retention despite holding `ip` and `user_agent` on
 * every auth attempt.
 *
 * A sweep that silently stops purging is invisible in production — nothing
 * fails, the tables just grow and the DPDP position quietly rots. So the
 * pinned properties are "it actually deleted something" and, just as
 * important, "it did NOT delete the dispute evidence".
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('retention') })
afterAll(async () => { await db?.drop() })

const hash = (id: string, code: string) =>
  crypto.createHash('sha256').update(`${id}:${code}`).digest('hex')

async function sweep() {
  return one<{
    otp_purged: number
    audit_purged: number
    events_purged: number
    challenges_purged: number
    buckets_purged: number
  }>(await db.sql`select app.sweep()`)
}

async function orderFor(user: string, sku = 'RL-CUFF-01'): Promise<string> {
  const out = one<{ order_id: string }>(
    await db.sql`select app.create_order(${user},
      ${db.sql.json([{ sku, qty: 1 }])}::jsonb, ${idem('ret')})`,
  )
  return out.order_id
}

async function auditRow(args: { orderId: string | null; ageDays: number }) {
  await db.sql`
    insert into auth_audit_log (user_id, order_id, event, outcome, ip, user_agent, created_at)
    values (${ALICE}, ${args.orderId}::uuid, ${'passkey_assert'}, ${'success'},
            ${'203.0.113.7'}::inet, ${'test-agent'},
            now() - make_interval(days => ${args.ageDays}))
  `
}

describe('app.sweep — OTP purge (was orphaned before 0011)', () => {
  it('purges a consumed code once it is past its window', async () => {
    const id = 'sweep-consumed@example.com'
    one(await db.sql`select app.create_otp_challenge(
      ${id}, ${hash(id, '424242')}, ${null}, ${'verify'}, ${300}, ${5})`)
    one(await db.sql`select app.verify_otp_challenge(${id}, ${'verify'}, ${hash(id, '424242')}, ${null})`)

    // Consumed a day and a half ago.
    await db.sql`update otp_challenges
                    set consumed_at = now() - interval '36 hours'
                  where identifier = ${id}`

    const report = await sweep()
    expect(report.otp_purged).toBeGreaterThanOrEqual(1)

    const left = (await db.sql`
      select count(*)::int as n from otp_challenges where identifier = ${id}
    `) as unknown as Array<{ n: number }>
    expect(left[0]!.n).toBe(0)
  })

  it('leaves a live, unconsumed code alone', async () => {
    const id = 'sweep-live@example.com'
    one(await db.sql`select app.create_otp_challenge(
      ${id}, ${hash(id, '515151')}, ${null}, ${'verify'}, ${300}, ${5})`)

    await sweep()

    const left = (await db.sql`
      select count(*)::int as n from otp_challenges where identifier = ${id}
    `) as unknown as Array<{ n: number }>
    expect(left[0]!.n).toBe(1)
  })
})

describe('app.sweep — audit retention', () => {
  it('purges audit rows past the retention window', async () => {
    await auditRow({ orderId: null, ageDays: 500 })

    const report = await sweep()
    expect(report.audit_purged).toBeGreaterThanOrEqual(1)
  })

  it('keeps audit rows inside the window', async () => {
    const order = await orderFor(ALICE)
    await auditRow({ orderId: order, ageDays: 30 })

    await sweep()

    const left = (await db.sql`
      select count(*)::int as n from auth_audit_log where order_id = ${order}::uuid
    `) as unknown as Array<{ n: number }>
    expect(left[0]!.n).toBe(1)
  })

  it('NEVER purges the audit trail of a disputed order, however old', async () => {
    const order = await orderFor(ALICE)
    await auditRow({ orderId: order, ageDays: 900 })
    await db.sql`
      insert into disputes (order_id, razorpay_dispute_id, status, amount_paise)
      values (${order}::uuid, ${idem('disp')}, ${'open'}, ${100})
    `

    await sweep()

    // This row is 900 days old — well past retention — and must survive,
    // because it is the evidence the dispute would be answered with.
    const left = (await db.sql`
      select count(*)::int as n from auth_audit_log where order_id = ${order}::uuid
    `) as unknown as Array<{ n: number }>
    expect(left[0]!.n).toBe(1)
  })

  it('honours an explicit, shorter retention window', async () => {
    const order = await orderFor(ALICE)
    await auditRow({ orderId: order, ageDays: 10 })

    // 400 days would keep it; 5 days must not.
    one(await db.sql`select app.sweep(${5})`)

    const left = (await db.sql`
      select count(*)::int as n from auth_audit_log where order_id = ${order}::uuid
    `) as unknown as Array<{ n: number }>
    expect(left[0]!.n).toBe(0)
  })
})
