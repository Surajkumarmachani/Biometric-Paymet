import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, paise, ALICE, PRIYA, STORE, idem, type TestDb } from '../setup/pg'

/**
 * Gate: PRICE TAMPER.
 *
 * The root of trust for money. If a caller can influence the amount here, every
 * downstream "server-derived amount" guarantee is decorative.
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('pricing') })
afterAll(async () => { await db?.drop() })

describe('server-side pricing', () => {
  it('prices from product_prices, ignoring any amount in the payload', async () => {
    // The caller tries to inject amount, unit_paise and line_paise. The function
    // signature has no amount parameter, so these are simply not read.
    const out = one<{ amount_paise: string; line_items: Array<Record<string, unknown>> }>(
      await db.sql`
        select app.create_order(
          ${ALICE},
          ${db.sql.json([
            { sku: 'RL-CUFF-01', qty: 2, amount_paise: 1, unit_paise: 1, line_paise: 1 },
          ])}::jsonb,
          ${idem('tamper')}
        )
      `,
    )

    // 2 x ₹45,000 = ₹90,000
    expect(paise(out.amount_paise)).toBe(9_000_000)
    expect(out.line_items[0]!.unit_paise).toBe(4500000)
  })

  it('uses the CURRENT price, not a superseded one', async () => {
    // RL-CUFF-01 has a superseded ₹39,000 row and a current ₹45,000 row.
    const out = one<{ amount_paise: string }>(
      await db.sql`
        select app.create_order(${ALICE},
          ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb, ${idem('cur')})
      `,
    )
    expect(paise(out.amount_paise)).toBe(4_500_000)
  })

  it('records which price row was used, for audit', async () => {
    const out = one<{ line_items: Array<{ price_id: string }> }>(
      await db.sql`
        select app.create_order(${ALICE},
          ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb, ${idem('pid')})
      `,
    )
    const priceId = out.line_items[0]!.price_id
    const rows = await db.sql`
      select valid_to from product_prices where id = ${priceId}::uuid
    `
    expect((rows as unknown as Array<{ valid_to: unknown }>)[0]!.valid_to).toBeNull()
  })

  it('rejects an unknown sku rather than pricing it at zero', async () => {
    await expect(
      db.sql`select app.create_order(${ALICE},
        ${db.sql.json([{ sku: 'NOT-A-THING', qty: 1 }])}::jsonb, ${idem('bad')})`,
    ).rejects.toThrow(/unknown sku/)
  })

  it('rejects an inactive product', async () => {
    await expect(
      db.sql`select app.create_order(${ALICE},
        ${db.sql.json([{ sku: 'RL-GONE-05', qty: 1 }])}::jsonb, ${idem('gone')})`,
    ).rejects.toThrow(/unknown sku|inactive/)
  })

  it('rejects a partially-priceable basket wholesale', async () => {
    // One good line, one bad. Must fail entirely — never silently drop a line
    // and charge for the rest.
    await expect(
      db.sql`select app.create_order(${ALICE},
        ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }, { sku: 'NOPE', qty: 1 }])}::jsonb,
        ${idem('mixed')})`,
    ).rejects.toThrow(/unknown sku/)
  })

  it('rejects qty < 1', async () => {
    await expect(
      db.sql`select app.create_order(${ALICE},
        ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 0 }])}::jsonb, ${idem('zero')})`,
    ).rejects.toThrow()
  })

  it('rejects an empty basket', async () => {
    await expect(
      db.sql`select app.create_order(${ALICE}, ${'[]'}::jsonb, ${idem('empty')})`,
    ).rejects.toThrow(/at least one line/)
  })
})

describe('idempotency', () => {
  it('returns the SAME order for a replayed idempotency key', async () => {
    const key = idem('replay')
    const first = one<{ order_id: string; replayed: boolean }>(
      await db.sql`select app.create_order(${ALICE},
        ${db.sql.json([{ sku: 'RL-PIN-04', qty: 1 }])}::jsonb, ${key})`,
    )
    const second = one<{ order_id: string; replayed: boolean }>(
      await db.sql`select app.create_order(${ALICE},
        ${db.sql.json([{ sku: 'RL-PIN-04', qty: 3 }])}::jsonb, ${key})`,
    )

    expect(second.order_id).toBe(first.order_id)
    expect(second.replayed).toBe(true)

    // Critically: the replay did NOT re-price to 3 units.
    const rows = (await db.sql`
      select amount_paise from orders where id = ${first.order_id}::uuid
    `) as unknown as Array<{ amount_paise: string }>
    expect(paise(rows[0]!.amount_paise)).toBe(100_000)
  })

  it('rejects an idempotency key too long for a Razorpay receipt', async () => {
    await expect(
      db.sql`select app.create_order(${ALICE},
        ${db.sql.json([{ sku: 'RL-PIN-04', qty: 1 }])}::jsonb, ${'x'.repeat(41)})`,
    ).rejects.toThrow(/40/)
  })
})

describe('in-store orders', () => {
  it('creates an unclaimed order with a hashed claim token', async () => {
    const out = one<{ order_id: string; status: string }>(
      await db.sql`
        select app.create_order(
          ${null},
          ${db.sql.json([{ sku: 'RL-RING-02', qty: 1 }])}::jsonb,
          ${idem('store')},
          ${STORE}::uuid,
          ${PRIYA},
          ${'a'.repeat(64)},
          ${900}
        )
      `,
    )
    expect(out.status).toBe('draft')

    const rows = (await db.sql`
      select user_id, claim_token_hash, claim_token_expires_at > now() as live
        from orders where id = ${out.order_id}::uuid
    `) as unknown as Array<{ user_id: string | null; claim_token_hash: string; live: boolean }>

    expect(rows[0]!.user_id).toBeNull()          // nobody owns it yet
    expect(rows[0]!.claim_token_hash).toBe('a'.repeat(64))
    expect(rows[0]!.live).toBe(true)
  })
})
