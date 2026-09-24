import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, ALICE, BOB, PRIYA, STORE, idem, type TestDb } from '../setup/pg'

/**
 * Gate: QR CLAIM.
 *
 * Two properties that pull in opposite directions and must both hold:
 *   * idempotent for the SAME customer, so a page refresh does not dead-end
 *   * single-winner across DIFFERENT customers, so two people scanning the same
 *     code cannot both take the order
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('claim') })
afterAll(async () => { await db?.drop() })

async function makeStoreOrder(tokenHash: string, ttl = 900): Promise<string> {
  const out = one<{ order_id: string }>(
    await db.sql`
      select app.create_order(
        ${null},
        ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb,
        ${idem('claim')},
        ${STORE}::uuid,
        ${PRIYA},
        ${tokenHash},
        ${ttl}
      )
    `,
  )
  return out.order_id
}

describe('claim', () => {
  it('binds the order to the first authenticated customer', async () => {
    const hash = 'b'.repeat(64)
    const orderId = await makeStoreOrder(hash)

    const out = one<{ claimed: boolean; order_id: string; status: string }>(
      await db.sql`select app.claim_order(${hash}, ${ALICE})`,
    )
    expect(out.claimed).toBe(true)
    expect(out.order_id).toBe(orderId)
    expect(out.status).toBe('claimed')
  })

  it('is idempotent for the same customer — a refresh must not dead-end', async () => {
    const hash = 'c'.repeat(64)
    await makeStoreOrder(hash)

    const first = one<{ claimed: boolean }>(await db.sql`select app.claim_order(${hash}, ${ALICE})`)
    const refresh = one<{ claimed: boolean; status: string }>(
      await db.sql`select app.claim_order(${hash}, ${ALICE})`,
    )

    expect(first.claimed).toBe(true)
    expect(refresh.claimed).toBe(true)   // ← the v2 bug: this used to be false
    expect(refresh.status).toBe('claimed')
  })

  it('refuses a second, different customer', async () => {
    const hash = 'd'.repeat(64)
    await makeStoreOrder(hash)

    const alice = one<{ claimed: boolean }>(await db.sql`select app.claim_order(${hash}, ${ALICE})`)
    const bob = one<{ claimed: boolean }>(await db.sql`select app.claim_order(${hash}, ${BOB})`)

    expect(alice.claimed).toBe(true)
    expect(bob.claimed).toBe(false)
  })

  it('has exactly one winner under a concurrent race', async () => {
    const hash = 'e'.repeat(64)
    await makeStoreOrder(hash)

    // Fire both claims at once from different connections.
    const [a, b] = await Promise.all([
      db.sql`select app.claim_order(${hash}, ${ALICE})`,
      db.sql`select app.claim_order(${hash}, ${BOB})`,
    ])

    const results = [one<{ claimed: boolean }>(a), one<{ claimed: boolean }>(b)]
    expect(results.filter((r) => r.claimed).length).toBe(1)

    const rows = (await db.sql`
      select user_id from orders where claim_token_hash = ${hash}
    `) as unknown as Array<{ user_id: string }>
    expect([ALICE, BOB]).toContain(rows[0]!.user_id)
  })

  it('refuses an expired token', async () => {
    const hash = 'f'.repeat(64)
    const orderId = await makeStoreOrder(hash)
    await db.sql`
      update orders set claim_token_expires_at = now() - interval '1 second'
       where id = ${orderId}::uuid
    `

    const out = one<{ claimed: boolean }>(await db.sql`select app.claim_order(${hash}, ${ALICE})`)
    expect(out.claimed).toBe(false)
  })

  it('refuses an unknown token', async () => {
    const out = one<{ claimed: boolean }>(
      await db.sql`select app.claim_order(${'0'.repeat(64)}, ${ALICE})`,
    )
    expect(out.claimed).toBe(false)
  })

  it('refuses to re-claim an order that has moved past claimed', async () => {
    const hash = '9'.repeat(64)
    const orderId = await makeStoreOrder(hash)
    await db.sql`select app.claim_order(${hash}, ${ALICE})`
    await db.sql`update orders set status = 'paid' where id = ${orderId}::uuid`

    const out = one<{ claimed: boolean }>(await db.sql`select app.claim_order(${hash}, ${ALICE})`)
    expect(out.claimed).toBe(false)
  })
})
