import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, ALICE, BOB, idem, type TestDb } from '../setup/pg'

/**
 * Gate: AUTHORIZATION.
 *
 * UNIQUE (kind, ref) on payment_authorizations is the single-use guarantee for
 * Option A. Without it, a captured Clerk reverification_id could authorise any
 * number of payments.
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('authorization') })
afterAll(async () => { await db?.drop() })

async function orderFor(user: string, sku = 'RL-CUFF-01'): Promise<{ id: string; amount: number }> {
  const out = one<{ order_id: string; amount_paise: string }>(
    await db.sql`select app.create_order(${user},
      ${db.sql.json([{ sku, qty: 1 }])}::jsonb, ${idem('auth')})`,
  )
  return { id: out.order_id, amount: Number(out.amount_paise) }
}

describe('record_authorization', () => {
  it('locks the order to intent_verified', async () => {
    const order = await orderFor(ALICE)
    one(await db.sql`
      select app.record_authorization(${order.id}::uuid, 'clerk_reverification',
        ${'rev_aaa'}, ${ALICE}, ${order.amount})
    `)

    const rows = (await db.sql`
      select status from orders where id = ${order.id}::uuid
    `) as unknown as Array<{ status: string }>
    expect(rows[0]!.status).toBe('intent_verified')
  })

  it('rejects a REPLAYED reverification_id', async () => {
    const first = await orderFor(ALICE)
    const second = await orderFor(ALICE)

    one(await db.sql`
      select app.record_authorization(${first.id}::uuid, 'clerk_reverification',
        ${'rev_replay'}, ${ALICE}, ${first.amount})
    `)

    // Same reverification_id, different order. This is the attack.
    await expect(
      db.sql`
        select app.record_authorization(${second.id}::uuid, 'clerk_reverification',
          ${'rev_replay'}, ${ALICE}, ${second.amount})
      `,
    ).rejects.toThrow(/already used/)
  })

  it('rejects an amount that does not match the order', async () => {
    const order = await orderFor(ALICE)
    await expect(
      db.sql`
        select app.record_authorization(${order.id}::uuid, 'clerk_reverification',
          ${'rev_bad_amount'}, ${ALICE}, ${1})
      `,
    ).rejects.toThrow(/does not match order amount/)
  })

  it('rejects authorization by a different user', async () => {
    const order = await orderFor(ALICE)
    await expect(
      db.sql`
        select app.record_authorization(${order.id}::uuid, 'clerk_reverification',
          ${'rev_wrong_user'}, ${BOB}, ${order.amount})
      `,
    ).rejects.toThrow(/not owned by this user/)
  })

  it('rejects an order that has already been paid', async () => {
    const order = await orderFor(ALICE)
    await db.sql`update orders set status = 'paid' where id = ${order.id}::uuid`
    await expect(
      db.sql`
        select app.record_authorization(${order.id}::uuid, 'clerk_reverification',
          ${'rev_paid'}, ${ALICE}, ${order.amount})
      `,
    ).rejects.toThrow(/not in an authorizable state/)
  })

  it('allows a fresh authorization after a failed payment (retry)', async () => {
    const order = await orderFor(ALICE)
    await db.sql`update orders set status = 'payment_failed' where id = ${order.id}::uuid`

    one(await db.sql`
      select app.record_authorization(${order.id}::uuid, 'clerk_reverification',
        ${'rev_retry'}, ${ALICE}, ${order.amount})
    `)

    const rows = (await db.sql`
      select status from orders where id = ${order.id}::uuid
    `) as unknown as Array<{ status: string }>
    expect(rows[0]!.status).toBe('intent_verified')
  })

  it('keeps Option A and Option B references in separate namespaces', async () => {
    const a = await orderFor(ALICE)
    const b = await orderFor(ALICE)

    // The same literal string is a legitimate ref for each kind.
    one(await db.sql`
      select app.record_authorization(${a.id}::uuid, 'clerk_reverification',
        ${'shared-ref'}, ${ALICE}, ${a.amount})
    `)
    one(await db.sql`
      select app.record_authorization(${b.id}::uuid, 'webauthn_assertion',
        ${'shared-ref'}, ${ALICE}, ${b.amount}, ${'cred_123'})
    `)

    const rows = (await db.sql`
      select count(*)::int as n from payment_authorizations where ref = ${'shared-ref'}
    `) as unknown as Array<{ n: number }>
    expect(rows[0]!.n).toBe(2)
  })
})

describe('S3: passkey bound to payment', () => {
  // The gesture is bound to THIS order and THIS amount, not to the session at
  // large — that binding is the payment authorisation.
  it('binds the reverification to the specific order + amount + user', async () => {
    const order = await orderFor(ALICE)
    one(await db.sql`
      select app.record_authorization(${order.id}::uuid, 'clerk_reverification',
        ${'rev_bind'}, ${ALICE}, ${order.amount})
    `)
    const rows = (await db.sql`
      select order_id, kind, ref, amount_paise, user_id
        from payment_authorizations where ref = ${'rev_bind'}
    `) as unknown as Array<{ order_id: string; kind: string; ref: string; amount_paise: string; user_id: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.order_id).toBe(order.id)
    expect(rows[0]!.kind).toBe('clerk_reverification')
    expect(Number(rows[0]!.amount_paise)).toBe(order.amount)
    expect(rows[0]!.user_id).toBe(ALICE)
  })

  // A reverification is single-use. The authorize route detects a spent id with
  // exactly this lookup and forces a fresh step-up instead of replaying it.
  it('makes a spent reverification_id detectable (drives the fresh-step-up)', async () => {
    const order = await orderFor(ALICE)
    one(await db.sql`
      select app.record_authorization(${order.id}::uuid, 'clerk_reverification',
        ${'rev_spent'}, ${ALICE}, ${order.amount})
    `)
    const spent = (await db.sql`
      select exists(select 1 from payment_authorizations
        where kind = 'clerk_reverification' and ref = ${'rev_spent'}) as used
    `) as unknown as Array<{ used: boolean }>
    const fresh = (await db.sql`
      select exists(select 1 from payment_authorizations
        where kind = 'clerk_reverification' and ref = ${'rev_never_used'}) as used
    `) as unknown as Array<{ used: boolean }>
    expect(spent[0]!.used).toBe(true)
    expect(fresh[0]!.used).toBe(false)
  })
})

describe('attach_razorpay_order', () => {
  it('creates once and then REUSES, so a retry cannot orphan a Razorpay order', async () => {
    const order = await orderFor(ALICE)
    one(await db.sql`
      select app.record_authorization(${order.id}::uuid, 'clerk_reverification',
        ${'rev_attach'}, ${ALICE}, ${order.amount})
    `)

    const first = one<{ razorpay_order_id: string; created: boolean }>(
      await db.sql`select app.attach_razorpay_order(${order.id}::uuid, ${'order_RZP001'})`,
    )
    expect(first.created).toBe(true)
    expect(first.razorpay_order_id).toBe('order_RZP001')

    // A retry offering a DIFFERENT id must be ignored in favour of the existing one.
    const second = one<{ razorpay_order_id: string; created: boolean }>(
      await db.sql`select app.attach_razorpay_order(${order.id}::uuid, ${'order_RZP999'})`,
    )
    expect(second.created).toBe(false)
    expect(second.razorpay_order_id).toBe('order_RZP001')

    const rows = (await db.sql`
      select razorpay_order_id, status from orders where id = ${order.id}::uuid
    `) as unknown as Array<{ razorpay_order_id: string; status: string }>
    expect(rows[0]!.razorpay_order_id).toBe('order_RZP001')
    expect(rows[0]!.status).toBe('awaiting_payment')
  })

  it('reopens the payment window on retry from payment_failed', async () => {
    const order = await orderFor(ALICE)
    one(await db.sql`
      select app.record_authorization(${order.id}::uuid, 'clerk_reverification',
        ${'rev_reopen'}, ${ALICE}, ${order.amount})
    `)
    one(await db.sql`select app.attach_razorpay_order(${order.id}::uuid, ${'order_RZP002'})`)
    await db.sql`update orders set status = 'payment_failed' where id = ${order.id}::uuid`

    one(await db.sql`select app.attach_razorpay_order(${order.id}::uuid, ${'order_RZP002'})`)

    const rows = (await db.sql`
      select status, next_poll_at is not null as polling from orders where id = ${order.id}::uuid
    `) as unknown as Array<{ status: string; polling: boolean }>
    expect(rows[0]!.status).toBe('awaiting_payment')
    expect(rows[0]!.polling).toBe(true)
  })
})
