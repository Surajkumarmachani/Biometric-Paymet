import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, ALICE, BOB, PRIYA, STORE, type TestDb } from '../setup/pg'

/**
 * Gate: STAFF ACCESS MANAGEMENT (0020).
 *
 * app.admin_set_staff is the only way the app changes anyone's access. These
 * pin every rule it promises: admin-only, never your own access, known users
 * and stores only, never zero admins, and an audit row for every change.
 */

let db: TestDb
beforeAll(async () => {
  db = await createTestDb('staffadmin')
  await db.sql`insert into app_users (clerk_id, email) values
    ('user_admin_a', 'admin-a@regallab.example'),
    ('user_admin_b', 'admin-b@regallab.example'),
    ('user_new_hire', 'new-hire@regallab.example')`
  await db.sql`insert into staff (clerk_id, store_id, role) values
    ('user_admin_a', ${STORE}::uuid, 'admin'),
    ('user_admin_b', ${STORE}::uuid, 'admin')`
})
afterAll(async () => { await db?.drop() })

type Result = { clerk_id: string; role: string; store_id: string; active: boolean; created: boolean }
const set = (actor: string, target: string, role: string, active = true, store = STORE) =>
  db.sql`select app.admin_set_staff(${actor}, ${target}, ${store}::uuid, ${role}::staff_role, ${active})`.then(
    (r) => one<Result>(r),
  )
const staffRow = async (id: string) =>
  ((await db.sql`select role, active from staff where clerk_id = ${id}`) as unknown as Array<{ role: string; active: boolean }>)[0]

describe('who may change access', () => {
  it('an admin can grant a new person a role', async () => {
    const r = await set('user_admin_a', 'user_new_hire', 'associate')
    expect(r).toMatchObject({ role: 'associate', active: true, created: true })
  })

  it('an admin can promote, move and deactivate', async () => {
    expect((await set('user_admin_a', 'user_new_hire', 'manager')).role).toBe('manager')
    const off = await set('user_admin_a', 'user_new_hire', 'manager', false)
    expect(off.active).toBe(false)
    expect(off.created).toBe(false)
  })

  it('a manager cannot change anyone', async () => {
    await expect(set(PRIYA, ALICE, 'admin')).rejects.toMatchObject({ code: '42501' })
  })

  it('a customer cannot change anyone', async () => {
    await expect(set(ALICE, BOB, 'admin')).rejects.toMatchObject({ code: '42501' })
  })

  it('an inactive admin cannot change anyone', async () => {
    await db.sql`insert into app_users (clerk_id) values ('user_admin_off')`
    await db.sql`insert into staff (clerk_id, store_id, role, active) values ('user_admin_off', ${STORE}::uuid, 'admin', false)`
    await expect(set('user_admin_off', BOB, 'associate')).rejects.toMatchObject({ code: '42501' })
  })
})

describe('guard rails', () => {
  it('nobody can change their own access', async () => {
    await expect(set('user_admin_a', 'user_admin_a', 'associate')).rejects.toMatchObject({ code: '42501' })
    expect((await staffRow('user_admin_a'))!.role).toBe('admin')
  })

  it('refuses someone who has never signed in', async () => {
    await expect(set('user_admin_a', 'user_never_seen', 'associate')).rejects.toMatchObject({ code: '22023' })
  })

  it('refuses an unknown store', async () => {
    await expect(
      set('user_admin_a', BOB, 'associate', true, '99999999-9999-9999-9999-999999999999'),
    ).rejects.toMatchObject({ code: '22023' })
  })

  it('once admin B is demoted, B can no longer demote A — never zero admins', async () => {
    await set('user_admin_a', 'user_admin_b', 'manager')
    await expect(set('user_admin_b', 'user_admin_a', 'associate')).rejects.toMatchObject({ code: '42501' })
    expect((await staffRow('user_admin_a'))!.role).toBe('admin')
    // restore for later tests
    await set('user_admin_a', 'user_admin_b', 'admin')
  })

  it('two admins demoting each other at the same time cannot both succeed', async () => {
    const results = await Promise.allSettled([
      db.sql.begin((tx) => tx`select app.admin_set_staff('user_admin_a', 'user_admin_b', ${STORE}::uuid, 'associate', true)`),
      db.sql.begin((tx) => tx`select app.admin_set_staff('user_admin_b', 'user_admin_a', ${STORE}::uuid, 'associate', true)`),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const admins = (await db.sql`select count(*)::int as n from staff where role = 'admin' and active`) as unknown as Array<{ n: number }>
    expect(admins[0]!.n).toBeGreaterThanOrEqual(1)
  })
})

describe('audit', () => {
  it('records who changed whom, before and after', async () => {
    await set('user_admin_a', BOB, 'associate')
    await set('user_admin_a', BOB, 'manager')
    const rows = (await db.sql`
      select user_id, detail from auth_audit_log
       where event = 'staff_access_changed' and detail->>'target' = ${BOB}
       order by id
    `) as unknown as Array<{ user_id: string; detail: { before: { role: string } | null; after: { role: string } } }>
    expect(rows).toHaveLength(2)
    expect(rows[0]!.user_id).toBe('user_admin_a')
    expect(rows[0]!.detail.before).toBeNull()
    expect(rows[1]!.detail.before!.role).toBe('associate')
    expect(rows[1]!.detail.after.role).toBe('manager')
  })

  it('a refused change leaves no audit row and no staff change', async () => {
    const before = (await db.sql`select count(*)::int as n from auth_audit_log where event = 'staff_access_changed'`) as unknown as Array<{ n: number }>
    await expect(set(PRIYA, BOB, 'admin')).rejects.toBeTruthy()
    const after = (await db.sql`select count(*)::int as n from auth_audit_log where event = 'staff_access_changed'`) as unknown as Array<{ n: number }>
    expect(after[0]!.n).toBe(before[0]!.n)
    expect((await staffRow(BOB))!.role).toBe('manager')
  })
})
