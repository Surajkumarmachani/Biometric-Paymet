import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, ALICE, idem, type TestDb } from '../setup/pg'

/**
 * Gate: SETTLEMENT RECONCILIATION (S5).
 *
 * "captured" is not "in the bank". app.record_settlement_txn checks each settled
 * payment's gross against what we captured and flags any divergence — and stamps
 * the order with its settlement id on a clean match.
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('settlement') })
afterAll(async () => { await db?.drop() })

// A paid order with one captured attempt of `amount` paise.
async function paidWithCapture(amount = 4_500_000): Promise<{ orderId: string; paymentId: string }> {
  const o = one<{ order_id: string }>(
    await db.sql`select app.create_order(${ALICE},
      ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb, ${idem('set')})`,
  )
  await db.sql`update orders set status = 'paid' where id = ${o.order_id}::uuid`
  const paymentId = 'pay_' + idem('p').replace(/[^a-z0-9]/gi, '').slice(0, 14)
  await db.sql`
    insert into payment_attempts (order_id, razorpay_payment_id, method, status, amount_paise)
    values (${o.order_id}::uuid, ${paymentId}, 'upi', 'captured', ${amount})`
  return { orderId: o.order_id, paymentId }
}

describe('app.record_settlement_txn', () => {
  it('reconciles a settled payment whose gross matches capture, and stamps the order', async () => {
    const { orderId, paymentId } = await paidWithCapture(4_500_000)
    await db.sql`select app.record_settlement(${'setl_1'}, ${4_400_000}, ${100_000}, ${0}, 'processed', 'UTR123', now())`
    const out = one<{ reconciled: boolean; order_id: string }>(
      await db.sql`select app.record_settlement_txn(${'setl_1'}, ${paymentId}, 'payment', ${4_500_000}, ${90_000}, ${10_000}, ${4_400_000})`,
    )
    expect(out.reconciled).toBe(true)
    expect(out.order_id).toBe(orderId)

    const rows = (await db.sql`select settlement_id from orders where id = ${orderId}::uuid`) as unknown as Array<{ settlement_id: string }>
    expect(rows[0]!.settlement_id).toBe('setl_1')
  })

  it('flags a gross mismatch against what we captured', async () => {
    const { paymentId } = await paidWithCapture(4_500_000)
    await db.sql`select app.record_settlement(${'setl_2'}, ${1}, ${0}, ${0}, 'processed')`
    const out = one<{ reconciled: boolean; discrepancy: string }>(
      // settled gross says ₹40,000 but we captured ₹45,000
      await db.sql`select app.record_settlement_txn(${'setl_2'}, ${paymentId}, 'payment', ${4_000_000}, ${0}, ${0}, ${4_000_000})`,
    )
    expect(out.reconciled).toBe(false)
    expect(out.discrepancy).toMatch(/!=|does not|gross/i)
  })

  it('flags a settled payment with no matching attempt', async () => {
    await db.sql`select app.record_settlement(${'setl_3'}, ${1}, ${0}, ${0}, 'processed')`
    const out = one<{ reconciled: boolean; discrepancy: string }>(
      await db.sql`select app.record_settlement_txn(${'setl_3'}, ${'pay_ghost'}, 'payment', ${5000}, ${0}, ${0}, ${5000})`,
    )
    expect(out.reconciled).toBe(false)
    expect(out.discrepancy).toMatch(/no matching/i)
  })

  it('is idempotent on (settlement, payment, type)', async () => {
    const { paymentId } = await paidWithCapture(4_500_000)
    await db.sql`select app.record_settlement(${'setl_4'}, ${1}, ${0}, ${0}, 'processed')`
    await db.sql`select app.record_settlement_txn(${'setl_4'}, ${paymentId}, 'payment', ${4_500_000}, ${0}, ${0}, ${4_500_000})`
    await db.sql`select app.record_settlement_txn(${'setl_4'}, ${paymentId}, 'payment', ${4_500_000}, ${0}, ${0}, ${4_500_000})`
    const rows = (await db.sql`select count(*)::int as n from settlement_txns where razorpay_settlement_id = ${'setl_4'} and razorpay_payment_id = ${paymentId}`) as unknown as Array<{ n: number }>
    expect(rows[0]!.n).toBe(1)
  })
})
