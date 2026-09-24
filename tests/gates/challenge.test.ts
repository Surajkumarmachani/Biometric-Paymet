import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, paise, ALICE, BOB, idem, type TestDb } from '../setup/pg'

/**
 * Gate: CHALLENGE (Option B, WebAuthn).
 *
 * Three properties:
 *   * the amount is SELECTed from orders — there is no parameter to inject
 *   * consumption is atomic and single-use, so an assertion cannot be replayed
 *   * the row is returned WITH its challenge, because expectedChallenge needs it
 *     (v2 omitted it, which silently made expectedChallenge undefined — exactly
 *     the "tolerating a mismatch" failure the WebAuthn spec warns about)
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('challenge') })
afterAll(async () => { await db?.drop() })

async function orderFor(user: string, sku = 'RL-CUFF-01'): Promise<string> {
  const out = one<{ order_id: string }>(
    await db.sql`select app.create_order(${user},
      ${db.sql.json([{ sku, qty: 1 }])}::jsonb, ${idem('ch')})`,
  )
  return out.order_id
}

describe('challenge creation', () => {
  it('takes the amount from the order, not from the caller', async () => {
    const orderId = await orderFor(ALICE)
    const out = one<{ amount_paise: string; order_id: string }>(
      await db.sql`select app.create_payment_challenge(${'chal-1'}, ${ALICE}, ${orderId}::uuid)`,
    )
    expect(paise(out.amount_paise)).toBe(4_500_000)
    expect(out.order_id).toBe(orderId)
  })

  it('refuses to create a challenge for another user’s order', async () => {
    const orderId = await orderFor(ALICE)
    await expect(
      db.sql`select app.create_payment_challenge(${'chal-2'}, ${BOB}, ${orderId}::uuid)`,
    ).rejects.toThrow(/not payable/)
  })

  it('refuses an order that is not in a payable state', async () => {
    const orderId = await orderFor(ALICE)
    await db.sql`update orders set status = 'paid' where id = ${orderId}::uuid`
    await expect(
      db.sql`select app.create_payment_challenge(${'chal-3'}, ${ALICE}, ${orderId}::uuid)`,
    ).rejects.toThrow(/not payable/)
  })

  it('defaults the TTL to 3x the ceremony timeout, not 1x', async () => {
    const orderId = await orderFor(ALICE)
    one(await db.sql`select app.create_payment_challenge(${'chal-ttl'}, ${ALICE}, ${orderId}::uuid)`)

    const rows = (await db.sql`
      select extract(epoch from (expires_at - created_at))::int as secs
        from payment_challenges where challenge = ${'chal-ttl'}
    `) as unknown as Array<{ secs: number }>

    // 180s against a 60s ceremony timeout. Equal values cause intermittent
    // failures when FaceID is retried or the user app-switches.
    expect(rows[0]!.secs).toBeGreaterThanOrEqual(120)
  })
})

describe('challenge consumption', () => {
  it('returns the challenge itself, so expectedChallenge can be set', async () => {
    const orderId = await orderFor(ALICE)
    one(await db.sql`select app.create_payment_challenge(${'chal-4'}, ${ALICE}, ${orderId}::uuid)`)

    const out = one<{ consumed: boolean; challenge: string; amount_paise: string }>(
      await db.sql`select app.consume_payment_challenge(${'chal-4'})`,
    )
    expect(out.consumed).toBe(true)
    expect(out.challenge).toBe('chal-4')      // ← the v2 defect
    expect(paise(out.amount_paise)).toBe(4_500_000)
  })

  it('is single-use — a replayed assertion finds nothing', async () => {
    const orderId = await orderFor(ALICE)
    one(await db.sql`select app.create_payment_challenge(${'chal-5'}, ${ALICE}, ${orderId}::uuid)`)

    const first = one<{ consumed: boolean }>(
      await db.sql`select app.consume_payment_challenge(${'chal-5'})`,
    )
    const replay = one<{ consumed: boolean }>(
      await db.sql`select app.consume_payment_challenge(${'chal-5'})`,
    )

    expect(first.consumed).toBe(true)
    expect(replay.consumed).toBe(false)
  })

  it('has exactly one winner under a concurrent race', async () => {
    const orderId = await orderFor(ALICE)
    one(await db.sql`select app.create_payment_challenge(${'chal-6'}, ${ALICE}, ${orderId}::uuid)`)

    const results = await Promise.all([
      db.sql`select app.consume_payment_challenge(${'chal-6'})`,
      db.sql`select app.consume_payment_challenge(${'chal-6'})`,
      db.sql`select app.consume_payment_challenge(${'chal-6'})`,
    ])

    const consumed = results.map((r) => one<{ consumed: boolean }>(r)).filter((r) => r.consumed)
    expect(consumed.length).toBe(1)
  })

  it('refuses an expired challenge', async () => {
    const orderId = await orderFor(ALICE)
    one(await db.sql`select app.create_payment_challenge(${'chal-7'}, ${ALICE}, ${orderId}::uuid)`)
    await db.sql`
      update payment_challenges set expires_at = now() - interval '1 second'
       where challenge = ${'chal-7'}
    `

    const out = one<{ consumed: boolean }>(
      await db.sql`select app.consume_payment_challenge(${'chal-7'})`,
    )
    expect(out.consumed).toBe(false)
  })

  it('refuses an unknown challenge', async () => {
    const out = one<{ consumed: boolean }>(
      await db.sql`select app.consume_payment_challenge(${'never-existed'})`,
    )
    expect(out.consumed).toBe(false)
  })

  it('burns the challenge even when verification later fails', async () => {
    // The route consumes in its OWN committed transaction, before verifying.
    // Simulated here: consume, then the caller throws. The burn must persist.
    const orderId = await orderFor(ALICE)
    one(await db.sql`select app.create_payment_challenge(${'chal-8'}, ${ALICE}, ${orderId}::uuid)`)

    const consumed = one<{ consumed: boolean }>(
      await db.sql`select app.consume_payment_challenge(${'chal-8'})`,
    )
    expect(consumed.consumed).toBe(true)

    // ... signature verification fails here, request 500s ...

    const retry = one<{ consumed: boolean }>(
      await db.sql`select app.consume_payment_challenge(${'chal-8'})`,
    )
    expect(retry.consumed).toBe(false)
  })

  it('WARNS: wrapping consume and verify in one transaction reopens the replay window', async () => {
    // Documents why the route must NOT do this. If the consume is rolled back
    // with the failing verification, the challenge is reusable.
    const orderId = await orderFor(ALICE)
    one(await db.sql`select app.create_payment_challenge(${'chal-9'}, ${ALICE}, ${orderId}::uuid)`)

    await expect(
      db.sql.begin(async (tx) => {
        await tx`select app.consume_payment_challenge(${'chal-9'})`
        throw new Error('verification failed')
      }),
    ).rejects.toThrow('verification failed')

    const stillUsable = one<{ consumed: boolean }>(
      await db.sql`select app.consume_payment_challenge(${'chal-9'})`,
    )
    expect(stillUsable.consumed).toBe(true) // ← precisely the bug to avoid
  })
})
