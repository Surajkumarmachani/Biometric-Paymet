import 'server-only'
import { sql, rpc } from './db'
import { toPaise } from './money'
import { alertOn } from './audit'
import { fetchSettlements, fetchSettlementRecon, type ReconRow } from './razorpay/api'

/**
 * Settlement reconciliation (S5).
 *
 * Ingests Razorpay settlements (money paid to the bank) and the per-transaction
 * recon report, then checks each settled payment's gross against what we
 * captured. A mismatch (or a settled payment we can't match to an order) is
 * flagged via alertOn — it means the money that landed doesn't equal the money
 * we think we took.
 *
 * Test mode has no real settlements, so this returns zeros there; it exercises
 * for real only against a live account with completed payouts.
 */

export interface ReconResult {
  settlements: number
  txns: number
  reconciled: number
  discrepancies: number
}

function grossOf(r: ReconRow): number {
  const v = r.amount ?? r.credit ?? 0
  return toPaise(Math.round(v))
}
function paymentIdOf(r: ReconRow): string | null {
  return r.payment_id ?? r.entity_id ?? null
}

export async function reconcileSettlements(period?: { year: number; month: number; day?: number }): Promise<ReconResult> {
  // 1. Settlement summaries → durable record.
  const settlements = await fetchSettlements({ count: 100 })
  for (const s of settlements) {
    await sql`select app.record_settlement(
      ${s.id}, ${toPaise(Math.round(s.amount))}, ${toPaise(Math.round(s.fees ?? 0))},
      ${toPaise(Math.round(s.tax ?? 0))}, ${s.status}, ${s.utr ?? null},
      ${s.created_at ? new Date(s.created_at * 1000).toISOString() : null})`
  }

  // 2. Per-transaction recon for the period (caller passes it; the cron/worker
  //    supplies the current Y/M so this stays deterministic).
  let txns = 0, reconciled = 0, discrepancies = 0
  if (period) {
    const rows = await fetchSettlementRecon(period)
    for (const r of rows) {
      const paymentId = paymentIdOf(r)
      if (!paymentId) continue
      const type = r.type ?? 'payment'
      const gross = grossOf(r)
      const fee = toPaise(Math.round(r.fee ?? 0))
      const tax = toPaise(Math.round(r.tax ?? 0))
      const net = gross - fee - tax
      const out = await rpc<{ order_id: string | null; reconciled: boolean; discrepancy: string | null }>(sql`
        select app.record_settlement_txn(
          ${r.settlement_id ?? null}, ${paymentId}, ${type},
          ${gross}, ${fee}, ${tax}, ${net})`)
      txns++
      if (out.reconciled) {
        reconciled++
      } else if (type === 'payment') {
        discrepancies++
        alertOn('settlement_discrepancy', {
          paymentId,
          settlementId: r.settlement_id ?? null,
          grossPaise: gross,
          reason: out.discrepancy,
        })
      }
    }
  }

  return { settlements: settlements.length, txns, reconciled, discrepancies }
}
