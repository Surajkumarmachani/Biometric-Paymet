import 'server-only'
import { sql, rpc, jsonb } from './db'
import { toPaise, type Paise } from './money'

/**
 * GST tax invoice generation (S5).
 *
 * Retail jewellery prices are tax-INCLUSIVE, so we back out the taxable value
 * and the GST from the gross line amount, in integer paise. Intra-state supply
 * splits the tax into CGST + SGST; inter-state is a single IGST. All of this is
 * driven by the seller config below — set the real values in the environment.
 *
 * This computes the arithmetic; app.issue_invoice (0006) owns the consecutive
 * invoice number and the durable record. The correctness of rate/HSN/state
 * treatment is your CA's call, not this code's.
 */

export interface SellerConfig {
  gstin: string
  legalName: string
  address: string
  stateCode: string // GST state code, e.g. '29' (Karnataka)
  rateBps: number   // GST rate in basis points; 300 = 3% (gold jewellery)
  defaultHsn: string
}

export function sellerConfig(): SellerConfig {
  const rate = Number(process.env.GST_RATE_BPS)
  return {
    gstin: process.env.GST_SELLER_GSTIN ?? 'UNREGISTERED',
    legalName: process.env.GST_SELLER_LEGAL_NAME ?? 'REGAL LAB',
    address: process.env.GST_SELLER_ADDRESS ?? '',
    stateCode: process.env.GST_SELLER_STATE_CODE ?? '',
    rateBps: Number.isInteger(rate) && rate >= 0 ? rate : 300,
    defaultHsn: process.env.GST_DEFAULT_HSN ?? '7113',
  }
}

/** Split a tax-inclusive gross into taxable base + tax, in paise. */
export function splitInclusive(grossPaise: Paise, rateBps: number): { taxable: number; tax: number } {
  const taxable = Math.round((grossPaise * 10000) / (10000 + rateBps))
  return { taxable, tax: grossPaise - taxable }
}

export interface Invoice {
  id: string
  order_id: string
  invoice_no: string
  financial_year: string
  issued_at: string
  seller: Record<string, unknown>
  buyer: Record<string, unknown>
  place_of_supply: string | null
  line_items: unknown
  taxable_paise: string | number
  cgst_paise: string | number
  sgst_paise: string | number
  igst_paise: string | number
  total_paise: string | number
  currency: string
}

interface OrderLine {
  product_id?: string
  sku?: string
  name?: string
  qty?: number
  unit_paise?: number | string
  line_paise?: number | string
}

/**
 * Issue (or fetch, if already issued) the GST invoice for a PAID order.
 * Returns null if the order isn't found or isn't paid.
 */
export async function issueInvoiceForOrder(orderId: string): Promise<Invoice | null> {
  const rows = (await sql`
    select o.id, o.amount_paise, o.currency, o.line_items, o.user_id, o.status,
           u.email as buyer_email
      from orders o
      left join app_users u on u.clerk_id = o.user_id
     where o.id = ${orderId}::uuid
     limit 1
  `) as unknown as Array<{
    id: string
    amount_paise: string
    currency: string
    line_items: unknown
    user_id: string | null
    status: string
    buyer_email: string | null
  }>

  const order = rows[0]
  if (!order) return null
  if (order.status !== 'paid') return null // a tax invoice is issued only once paid

  const cfg = sellerConfig()
  const lines: OrderLine[] = Array.isArray(order.line_items) ? (order.line_items as OrderLine[]) : []

  const productIds = lines.map((l) => l.product_id).filter((x): x is string => Boolean(x))
  const hsnRows = productIds.length
    ? ((await sql`select id, hsn from products where id = any(${productIds}::uuid[])`) as unknown as Array<{ id: string; hsn: string | null }>)
    : []
  const hsnById = Object.fromEntries(hsnRows.map((r) => [r.id, r.hsn]))

  // Buyer state is not collected, so we assume intra-state supply (CGST+SGST)
  // with place of supply = the seller's state. Swap when you capture a billing
  // address; inter-state then becomes IGST.
  const intraState = true

  let taxable = 0, cgst = 0, sgst = 0, igst = 0
  const invLines = lines.map((l) => {
    const linePaise = toPaise(l.line_paise ?? 0)
    const { taxable: t, tax } = splitInclusive(linePaise, cfg.rateBps)
    const c = intraState ? Math.floor(tax / 2) : 0
    const s = intraState ? tax - c : 0
    const i = intraState ? 0 : tax
    taxable += t; cgst += c; sgst += s; igst += i
    return {
      sku: l.sku ?? null,
      name: l.name ?? null,
      qty: l.qty ?? 1,
      hsn: (l.product_id && hsnById[l.product_id]) || cfg.defaultHsn,
      unit_paise: Number(l.unit_paise ?? 0),
      line_paise: linePaise,
      taxable_paise: t,
      rate_bps: cfg.rateBps,
      cgst_paise: c,
      sgst_paise: s,
      igst_paise: i,
    }
  })

  const payload = {
    seller: { gstin: cfg.gstin, legal_name: cfg.legalName, address: cfg.address, state_code: cfg.stateCode },
    buyer: { email: order.buyer_email, clerk_id: order.user_id },
    place_of_supply: cfg.stateCode,
    line_items: invLines,
    taxable_paise: taxable,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: igst,
    total_paise: taxable + cgst + sgst + igst, // == order.amount_paise
    currency: order.currency,
  }

  return rpc<Invoice>(sql`select app.issue_invoice(${orderId}::uuid, ${jsonb(payload)}::jsonb)`)
}

/** Fetch an already-issued invoice, or null. */
export async function getInvoiceForOrder(orderId: string): Promise<Invoice | null> {
  const rows = (await sql`
    select to_jsonb(i) as inv from invoices i where i.order_id = ${orderId}::uuid limit 1
  `) as unknown as Array<{ inv: Invoice }>
  return rows[0]?.inv ?? null
}
