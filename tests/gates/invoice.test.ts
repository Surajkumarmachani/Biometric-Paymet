import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, ALICE, idem, type TestDb } from '../setup/pg'

/**
 * Gate: INVOICE (S5).
 *
 * app.issue_invoice owns the consecutive GST invoice number and the durable
 * record. The properties that matter legally:
 *   * exactly one invoice per order (idempotent) — re-issue returns the same number
 *   * numbers are consecutive within a financial year
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('invoice') })
afterAll(async () => { await db?.drop() })

async function paidOrder(): Promise<{ id: string; amount: number }> {
  const out = one<{ order_id: string; amount_paise: string }>(
    await db.sql`select app.create_order(${ALICE},
      ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb, ${idem('inv')})`,
  )
  await db.sql`update orders set status = 'paid' where id = ${out.order_id}::uuid`
  return { id: out.order_id, amount: Number(out.amount_paise) }
}

function payload(amount: number) {
  const taxable = Math.round((amount * 10000) / 10300) // 3%
  const tax = amount - taxable
  const cgst = Math.floor(tax / 2)
  return {
    seller: { gstin: '29ABCDE1234F1Z5', legal_name: 'REGAL LAB', state_code: '29' },
    buyer: { email: 'alice@example.com' },
    place_of_supply: '29',
    line_items: [{ sku: 'RL-CUFF-01', hsn: '7113', qty: 1, line_paise: amount, taxable_paise: taxable }],
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: tax - cgst,
    igst_paise: 0,
    total_paise: amount,
    currency: 'INR',
  }
}

describe('app.issue_invoice', () => {
  it('issues a numbered invoice for a paid order', async () => {
    const order = await paidOrder()
    const inv = one<{ invoice_no: string; total_paise: string }>(
      await db.sql`select app.issue_invoice(${order.id}::uuid, ${db.sql.json(payload(order.amount))}::jsonb)`,
    )
    expect(inv.invoice_no).toMatch(/^RL\/\d{4}-\d{2}\/\d{6}$/)
    expect(Number(inv.total_paise)).toBe(order.amount)
  })

  it('is idempotent — re-issuing returns the SAME number, one row', async () => {
    const order = await paidOrder()
    const first = one<{ invoice_no: string }>(
      await db.sql`select app.issue_invoice(${order.id}::uuid, ${db.sql.json(payload(order.amount))}::jsonb)`,
    )
    const second = one<{ invoice_no: string }>(
      await db.sql`select app.issue_invoice(${order.id}::uuid, ${db.sql.json(payload(order.amount))}::jsonb)`,
    )
    expect(second.invoice_no).toBe(first.invoice_no)

    const rows = (await db.sql`
      select count(*)::int as n from invoices where order_id = ${order.id}::uuid
    `) as unknown as Array<{ n: number }>
    expect(rows[0]!.n).toBe(1)
  })

  it('assigns consecutive numbers across orders in the same FY', async () => {
    const a = await paidOrder()
    const b = await paidOrder()
    const na = one<{ invoice_no: string }>(
      await db.sql`select app.issue_invoice(${a.id}::uuid, ${db.sql.json(payload(a.amount))}::jsonb)`,
    ).invoice_no
    const nb = one<{ invoice_no: string }>(
      await db.sql`select app.issue_invoice(${b.id}::uuid, ${db.sql.json(payload(b.amount))}::jsonb)`,
    ).invoice_no
    const seq = (s: string) => Number(s.split('/').pop())
    expect(seq(nb)).toBe(seq(na) + 1)
  })
})
