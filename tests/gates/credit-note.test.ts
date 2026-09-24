import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, ALICE, idem, type TestDb } from '../setup/pg'

/**
 * Gate: CREDIT NOTE (S5 #2).
 *
 * A refund/chargeback needs a GST credit note with its own consecutive series,
 * one per triggering event (idempotent on the refund/dispute id).
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('creditnote') })
afterAll(async () => { await db?.drop() })

async function paidOrder(): Promise<string> {
  const o = one<{ order_id: string }>(
    await db.sql`select app.create_order(${ALICE},
      ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb, ${idem('cn')})`,
  )
  await db.sql`update orders set status = 'paid', amount_captured_paise = amount_paise where id = ${o.order_id}::uuid`
  return o.order_id
}

function payload(amount: number) {
  const taxable = Math.round((amount * 10000) / 10300)
  const tax = amount - taxable
  const cgst = Math.floor(tax / 2)
  return {
    invoice_no: 'RL/2026-27/000009',
    reason: 'refund',
    seller: { gstin: '29ABCDE1234F1Z5', legal_name: 'REGAL LAB' },
    buyer: { email: 'alice@example.com' },
    line_items: [{ description: 'Refund', taxable_paise: taxable, cgst_paise: cgst, sgst_paise: tax - cgst, igst_paise: 0, amount_paise: amount }],
    taxable_paise: taxable, cgst_paise: cgst, sgst_paise: tax - cgst, igst_paise: 0,
    total_paise: amount, currency: 'INR',
  }
}

describe('app.issue_credit_note', () => {
  it('issues a numbered credit note referencing the invoice', async () => {
    const orderId = await paidOrder()
    const cn = one<{ credit_note_no: string; invoice_no: string; total_paise: string }>(
      await db.sql`select app.issue_credit_note(${orderId}::uuid, ${'rfnd_cn1'}, ${db.sql.json(payload(4_500_000))}::jsonb)`,
    )
    expect(cn.credit_note_no).toMatch(/^RL-CN\/\d{4}-\d{2}\/\d{6}$/)
    expect(cn.invoice_no).toBe('RL/2026-27/000009')
    expect(Number(cn.total_paise)).toBe(4_500_000)
  })

  it('is idempotent on the ref — a redelivered refund cannot double-issue', async () => {
    const orderId = await paidOrder()
    const a = one<{ credit_note_no: string }>(
      await db.sql`select app.issue_credit_note(${orderId}::uuid, ${'rfnd_cn2'}, ${db.sql.json(payload(4_500_000))}::jsonb)`,
    )
    const b = one<{ credit_note_no: string }>(
      await db.sql`select app.issue_credit_note(${orderId}::uuid, ${'rfnd_cn2'}, ${db.sql.json(payload(4_500_000))}::jsonb)`,
    )
    expect(b.credit_note_no).toBe(a.credit_note_no)
    const rows = (await db.sql`select count(*)::int as n from credit_notes where ref = ${'rfnd_cn2'}`) as unknown as Array<{ n: number }>
    expect(rows[0]!.n).toBe(1)
  })

  it('uses its own consecutive series, separate from invoices', async () => {
    const o1 = await paidOrder()
    const o2 = await paidOrder()
    const n1 = one<{ credit_note_no: string }>(await db.sql`select app.issue_credit_note(${o1}::uuid, ${'rfnd_cn3'}, ${db.sql.json(payload(1000))}::jsonb)`).credit_note_no
    const n2 = one<{ credit_note_no: string }>(await db.sql`select app.issue_credit_note(${o2}::uuid, ${'rfnd_cn4'}, ${db.sql.json(payload(1000))}::jsonb)`).credit_note_no
    const seq = (s: string) => Number(s.split('/').pop())
    expect(seq(n2)).toBe(seq(n1) + 1)
  })
})
