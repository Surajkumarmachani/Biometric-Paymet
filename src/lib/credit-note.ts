import 'server-only'
import { sql, rpc, jsonb } from './db'
import { toPaise, type Paise } from './money'
import { sellerConfig, splitInclusive, getInvoiceForOrder } from './invoice'

/**
 * GST credit notes for refunds and chargebacks (S5 #2).
 *
 * A refund/chargeback against an issued invoice needs a credit note that
 * references the original invoice and shows the tax adjustment on the credited
 * amount (tax-inclusive, same rate + intra-state split as the invoice). Keyed on
 * the triggering event id (refund/dispute) so a redelivered webhook is a no-op.
 *
 * Like the invoice engine, the tax treatment is only as correct as your seller
 * config; this is the mechanism, not tax advice.
 */

export interface CreditNote {
  id: string
  order_id: string
  invoice_no: string | null
  credit_note_no: string
  ref: string
  reason: string
  total_paise: string | number
}

export async function issueCreditNote(args: {
  orderId: string
  ref: string
  reason: 'refund' | 'chargeback'
  amountPaise?: Paise // defaults to the order's captured amount (full credit)
}): Promise<CreditNote | null> {
  const rows = (await sql`
    select o.amount_paise, o.amount_captured_paise, o.currency, o.user_id, u.email as buyer_email
      from orders o left join app_users u on u.clerk_id = o.user_id
     where o.id = ${args.orderId}::uuid limit 1
  `) as unknown as Array<{
    amount_paise: string
    amount_captured_paise: string
    currency: string
    user_id: string | null
    buyer_email: string | null
  }>
  const order = rows[0]
  if (!order) return null

  const captured = toPaise(order.amount_captured_paise) || toPaise(order.amount_paise)
  const amount = args.amountPaise && args.amountPaise > 0 ? args.amountPaise : captured
  if (amount <= 0) return null

  const cfg = sellerConfig()
  const { taxable, tax } = splitInclusive(amount, cfg.rateBps)
  // Intra-state assumption, consistent with the invoice engine.
  const cgst = Math.floor(tax / 2)
  const sgst = tax - cgst

  const invoice = await getInvoiceForOrder(args.orderId)

  const payload = {
    invoice_no: invoice?.invoice_no ?? null,
    reason: args.reason,
    seller: { gstin: cfg.gstin, legal_name: cfg.legalName, address: cfg.address, state_code: cfg.stateCode },
    buyer: { email: order.buyer_email, clerk_id: order.user_id },
    line_items: [
      {
        description: args.reason === 'chargeback' ? 'Chargeback adjustment' : 'Refund',
        rate_bps: cfg.rateBps,
        taxable_paise: taxable,
        cgst_paise: cgst,
        sgst_paise: sgst,
        igst_paise: 0,
        amount_paise: amount,
      },
    ],
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: 0,
    total_paise: amount,
    currency: order.currency,
  }

  return rpc<CreditNote>(sql`select app.issue_credit_note(${args.orderId}::uuid, ${args.ref}, ${jsonb(payload)}::jsonb)`)
}
