import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, expectDenied, ALICE, BOB, PRIYA, STORE, idem, type TestDb } from '../setup/pg'

/**
 * Gate: RLS.
 *
 * The whole design leans on one property: RLS enabled with ZERO policies denies
 * anon and authenticated, while service_role bypasses RLS. That claim is
 * load-bearing, so it gets tested rather than asserted.
 *
 * Also verifies the Clerk-vs-Supabase-Auth correction: policies must compare
 * auth.jwt()->>'sub', because auth.uid() casts the subject to uuid and a Clerk
 * subject ('user_2ab...') is not one.
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('rls') })
afterAll(async () => { await db?.drop() })

async function orderFor(user: string): Promise<string> {
  const out = one<{ order_id: string }>(
    await db.sql`select app.create_order(${user},
      ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb, ${idem('rls')})`,
  )
  return out.order_id
}

describe('the Clerk subject correction', () => {
  it('auth.uid() BREAKS on a Clerk subject — this is why policies use ->>sub', async () => {
    await expect(
      db.asAuthenticated(ALICE, async (tx) => tx`select auth.uid() as uid`),
    ).rejects.toThrow(/invalid input syntax for type uuid/)
  })

  it('auth.jwt()->>sub reads the Clerk subject correctly', async () => {
    const rows = await db.asAuthenticated(ALICE, async (tx) =>
      tx`select auth.jwt() ->> 'sub' as sub`,
    )
    expect((rows as unknown as Array<{ sub: string }>)[0]!.sub).toBe(ALICE)
  })
})

describe('orders visibility', () => {
  it('a customer sees only their own orders', async () => {
    const aliceOrder = await orderFor(ALICE)
    const bobOrder = await orderFor(BOB)

    const visible = await db.asAuthenticated(ALICE, async (tx) => {
      const rows = await tx`select id from orders`
      return (rows as unknown as Array<{ id: string }>).map((r) => r.id)
    })

    expect(visible).toContain(aliceOrder)
    expect(visible).not.toContain(bobOrder)
  })

  it('anon sees no orders at all', async () => {
    await orderFor(ALICE)
    // `orders` is granted to authenticated only, so anon is refused at the
    // table-privilege level — before RLS is even consulted.
    const how = await expectDenied(() => db.asAnon(async (tx) => tx`select id from orders`))
    expect(how).toBe('permission_denied')
  })

  it('a customer cannot write to orders even for their own row', async () => {
    const orderId = await orderFor(ALICE)
    await expect(
      db.asAuthenticated(ALICE, async (tx) =>
        tx`update orders set amount_paise = 1 where id = ${orderId}::uuid`,
      ),
    ).rejects.toThrow()
  })

  it('a customer cannot insert an order directly', async () => {
    await expect(
      db.asAuthenticated(ALICE, async (tx) =>
        tx`insert into orders (user_id, amount_paise, line_items, idempotency_key)
           values (${ALICE}, 1, '[]'::jsonb, ${idem('evil')})`,
      ),
    ).rejects.toThrow()
  })
})

describe('service-role-only tables (RLS on, zero policies)', () => {
  const locked = [
    'payment_challenges',
    'payment_authorizations',
    'razorpay_webhook_events',
    'rate_limits',
    'product_prices',
    'refunds',
    'disputes',
    'staff',
  ]

  for (const table of locked) {
    it(`${table} is denied to authenticated`, async () => {
      // Denial arrives as EITHER a permission error (no grant) or zero rows
      // (grant present, RLS with no policy). Both are denials.
      const how = await expectDenied(() =>
        db.asAuthenticated(ALICE, async (tx) =>
          tx.unsafe(`select count(*)::int as n from ${table}`),
        ),
      )
      expect(['permission_denied', 'no_rows']).toContain(how)
    })

    it(`${table} is denied to anon`, async () => {
      const how = await expectDenied(() =>
        db.asAnon(async (tx) => tx.unsafe(`select count(*)::int as n from ${table}`)),
      )
      expect(['permission_denied', 'no_rows']).toContain(how)
    })
  }

  it('price rows exist but are unreadable by a client', async () => {
    // Proves the denial above is real, not just an empty table.
    const asService = (await db.sql`
      select count(*)::int as n from product_prices
    `) as unknown as Array<{ n: number }>
    expect(asService[0]!.n).toBeGreaterThan(0)

    await expectDenied(() =>
      db.asAuthenticated(ALICE, async (tx) => tx`select count(*)::int as n from product_prices`),
    )
  })

  it('a client cannot execute the app.* functions', async () => {
    await expect(
      db.asAuthenticated(ALICE, async (tx) =>
        tx`select app.create_order(${ALICE},
             ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb, ${idem('nope')})`,
      ),
    ).rejects.toThrow(/permission denied/i)
  })

  it('a client cannot forge a challenge to authorise a payment', async () => {
    const orderId = await orderFor(ALICE)
    await expect(
      db.asAuthenticated(ALICE, async (tx) =>
        tx`insert into payment_challenges
             (challenge, user_id, order_id, amount_paise, expires_at)
           values ('forged', ${ALICE}, ${orderId}::uuid, 1, now() + interval '1 hour')`,
      ),
    ).rejects.toThrow()
  })
})

describe('catalogue', () => {
  it('is readable by anon, without exposing prices', async () => {
    const products = await db.asAnon(async (tx) => tx`select sku from products`)
    expect((products as unknown as unknown[]).length).toBeGreaterThan(0)

    await expectDenied(() =>
      db.asAnon(async (tx) => tx`select count(*)::int as n from product_prices`),
    )
  })

  it('hides inactive products', async () => {
    const rows = await db.asAnon(async (tx) => tx`select sku from products`)
    const skus = (rows as unknown as Array<{ sku: string }>).map((r) => r.sku)
    expect(skus).not.toContain('RL-GONE-05')
  })
})

describe('audit log exposure', () => {
  it('does not leak ip / user_agent / detail to the customer', async () => {
    await db.sql`
      insert into auth_audit_log (user_id, event, outcome, ip, user_agent, detail)
      values (${ALICE}, 'passkey_assert', 'success', '203.0.113.7'::inet,
              'SecretAgent/1.0', '{"internal":"do not show"}'::jsonb)
    `

    const view = await db.asAuthenticated(ALICE, async (tx) =>
      tx`select * from my_security_events`,
    )
    const row = (view as unknown as Array<Record<string, unknown>>)[0]!
    expect(row.event).toBe('passkey_assert')
    expect(row).not.toHaveProperty('ip')
    expect(row).not.toHaveProperty('user_agent')
    expect(row).not.toHaveProperty('detail')
  })

  it('shows a customer only their own events', async () => {
    await db.sql`
      insert into auth_audit_log (user_id, event, outcome)
      values (${BOB}, 'otp_fallback', 'success')
    `
    const view = await db.asAuthenticated(ALICE, async (tx) =>
      tx`select count(*)::int as n from my_security_events`,
    )
    const mine = (view as unknown as Array<{ n: number }>)[0]!.n

    const all = (await db.sql`select count(*)::int as n from auth_audit_log`) as unknown as Array<{
      n: number
    }>
    expect(mine).toBeLessThan(all[0]!.n)
  })
})

describe('rate limiting', () => {
  it('allows up to the limit then denies', async () => {
    const results: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const rows = (await db.sql`
        select app.rate_limit_hit(${'test:bucket'}, ${3}, make_interval(secs => 60)) as allowed
      `) as unknown as Array<{ allowed: boolean }>
      results.push(rows[0]!.allowed)
    }
    expect(results).toEqual([true, true, true, false, false])
  })

  it('resets after the window', async () => {
    await db.sql`select app.rate_limit_hit(${'test:window'}, ${1}, make_interval(secs => 60))`
    let rows = (await db.sql`
      select app.rate_limit_hit(${'test:window'}, ${1}, make_interval(secs => 60)) as allowed
    `) as unknown as Array<{ allowed: boolean }>
    expect(rows[0]!.allowed).toBe(false)

    await db.sql`update rate_limits set window_start = now() - interval '2 minutes'
                  where bucket = ${'test:window'}`

    rows = (await db.sql`
      select app.rate_limit_hit(${'test:window'}, ${1}, make_interval(secs => 60)) as allowed
    `) as unknown as Array<{ allowed: boolean }>
    expect(rows[0]!.allowed).toBe(true)
  })
})

describe('S4: staff terminal visibility (store-scoped)', () => {
  // In-store order: no customer yet (user_id null), bound to a store + staff.
  async function inStoreOrder(storeId: string, staffId: string): Promise<string> {
    const out = one<{ order_id: string }>(
      await db.sql`select app.create_order(${null},
        ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb, ${idem('s4')},
        ${storeId}::uuid, ${staffId}, ${'h_' + idem('t')}, 900)`,
    )
    return out.order_id
  }

  const OTHER_STORE = '22222222-2222-2222-2222-222222222222'
  const OTHER_STAFF = 'user_staff_other'

  it('staff sees an unclaimed in-store order for their own store', async () => {
    const orderId = await inStoreOrder(STORE, PRIYA)
    const visible = await db.asAuthenticated(PRIYA, async (tx) => {
      const rows = await tx`select id from orders where id = ${orderId}::uuid`
      return (rows as unknown as Array<{ id: string }>).map((r) => r.id)
    })
    expect(visible).toContain(orderId)
  })

  it('a non-staff customer cannot see an unclaimed in-store order', async () => {
    const orderId = await inStoreOrder(STORE, PRIYA)
    const n = await db.asAuthenticated(ALICE, async (tx) => {
      const rows = await tx`select id from orders where id = ${orderId}::uuid`
      return (rows as unknown as unknown[]).length
    })
    expect(n).toBe(0)
  })

  it('staff of a DIFFERENT store cannot see the order', async () => {
    await db.sql`insert into stores (id, name, mcc, active)
      values (${OTHER_STORE}::uuid, 'Other Store', '5944', true) on conflict do nothing`
    await db.sql`insert into app_users (clerk_id, email)
      values (${OTHER_STAFF}, 'other@example.com') on conflict do nothing`
    await db.sql`insert into staff (clerk_id, store_id, role, active)
      values (${OTHER_STAFF}, ${OTHER_STORE}::uuid, 'associate', true) on conflict do nothing`

    const orderId = await inStoreOrder(STORE, PRIYA) // belongs to STORE
    const n = await db.asAuthenticated(OTHER_STAFF, async (tx) => {
      const rows = await tx`select id from orders where id = ${orderId}::uuid`
      return (rows as unknown as unknown[]).length
    })
    expect(n).toBe(0)
  })

  it('is_staff_for_store: true for the store’s staff, false for a customer', async () => {
    const asStaff = await db.asAuthenticated(PRIYA, async (tx) =>
      tx`select public.is_staff_for_store(${STORE}::uuid) as ok`,
    )
    const asCustomer = await db.asAuthenticated(ALICE, async (tx) =>
      tx`select public.is_staff_for_store(${STORE}::uuid) as ok`,
    )
    expect((asStaff as unknown as Array<{ ok: boolean }>)[0]!.ok).toBe(true)
    expect((asCustomer as unknown as Array<{ ok: boolean }>)[0]!.ok).toBe(false)
  })
})
