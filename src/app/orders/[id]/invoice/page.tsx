import { auth } from '@clerk/nextjs/server'
import { sql } from '@/lib/db'
import { formatINR, toPaise } from '@/lib/money'
import { getInvoiceForOrder, issueInvoiceForOrder, type Invoice } from '@/lib/invoice'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Printable GST tax invoice for one order (S5). Customer-scoped: only the order
 * owner may view it. Browsers print-to-PDF, so no PDF dependency is needed.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { userId } = await auth()
  if (!userId) return <Shell><p>Please sign in to view this invoice.</p></Shell>

  /**
   * Who may view this invoice (service-role read, so we filter explicitly).
   *
   * The customer, obviously. But ALSO the staff who rang the sale up. The
   * terminal lands on /orders/<id> the moment a payment settles, and that page
   * offers staff "View GST tax invoice" — so an owner-only check sent the
   * associate to "Invoice not found." for every in-store sale. The invoice was
   * there the whole time; it was just scoped to the payer, who is a different
   * person from the operator in every handover.
   *
   * Scoped like /api/orders/[id]/status: associates see their own store,
   * managers and admins see any. Read-only either way — this page moves no
   * money and issues nothing the order has not already earned.
   */
  const orderRows = (await sql`
    select user_id, store_id from orders where id = ${id}::uuid limit 1
  `) as unknown as Array<{ user_id: string | null; store_id: string | null }>
  const order = orderRows[0]

  let permitted = !!order && order.user_id === userId
  if (order && !permitted) {
    const staff = (await sql`
      select store_id, role from staff
       where clerk_id = ${userId} and active
       limit 1
    `) as unknown as Array<{ store_id: string; role: string }>

    const row = staff[0]
    const privileged = row?.role === 'manager' || row?.role === 'admin'
    const sameStore = !!row && !!order.store_id && row.store_id === order.store_id
    permitted = !!row && (privileged || sameStore)
  }

  // Same-shaped message whether it is missing or merely not yours — "exists but
  // not yours" is not something a stranger should learn from the response.
  if (!permitted) return <Shell><p>Invoice not found.</p></Shell>

  // Fetch, or issue on demand if the order is paid but predates invoicing.
  let invoice: Invoice | null = await getInvoiceForOrder(id)
  if (!invoice) invoice = await issueInvoiceForOrder(id)
  if (!invoice) {
    return <Shell><p>An invoice is available once the order is paid.</p></Shell>
  }

  const seller = invoice.seller as { gstin?: string; legal_name?: string; address?: string; state_code?: string }
  const buyer = invoice.buyer as { email?: string | null }
  const lines = (Array.isArray(invoice.line_items) ? invoice.line_items : []) as Array<{
    sku?: string; name?: string; qty?: number; hsn?: string; line_paise?: number
    taxable_paise?: number; cgst_paise?: number; sgst_paise?: number; igst_paise?: number; rate_bps?: number
  }>
  const p = (v: unknown) => formatINR(toPaise(v as number))

  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '0.06em' }}>{seller.legal_name}</div>
          {seller.address && <div style={{ fontSize: 12, color: '#555', maxWidth: 320 }}>{seller.address}</div>}
          <div style={{ fontSize: 12, color: '#555' }}>GSTIN: {seller.gstin}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>TAX INVOICE</div>
          <div style={{ fontSize: 13 }}>{invoice.invoice_no}</div>
          <div style={{ fontSize: 12, color: '#555' }}>{new Date(invoice.issued_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}</div>
        </div>
      </div>

      <hr style={rule} />

      <div style={{ fontSize: 13 }}>
        <div><strong>Bill to:</strong> {buyer.email ?? '—'}</div>
        {invoice.place_of_supply && <div><strong>Place of supply:</strong> {invoice.place_of_supply}</div>}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16, fontSize: 13 }}>
        <thead>
          <tr>
            {['Item', 'HSN', 'Qty', 'Taxable', 'CGST', 'SGST', 'IGST', 'Amount'].map((h, i) => (
              <th key={h} style={{ ...th, textAlign: i < 2 ? 'left' : 'right' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td style={td}>{l.name ?? l.sku}</td>
              <td style={td}>{l.hsn}</td>
              <td style={{ ...td, textAlign: 'right' }}>{l.qty}</td>
              <td style={{ ...td, textAlign: 'right' }}>{p(l.taxable_paise)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{p(l.cgst_paise)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{p(l.sgst_paise)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{p(l.igst_paise)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{p(l.line_paise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 16, marginLeft: 'auto', width: 260, fontSize: 13 }}>
        <Row label="Taxable value" value={p(invoice.taxable_paise)} />
        <Row label="CGST" value={p(invoice.cgst_paise)} />
        <Row label="SGST" value={p(invoice.sgst_paise)} />
        <Row label="IGST" value={p(invoice.igst_paise)} />
        <div style={{ borderTop: '1px solid #000', marginTop: 6, paddingTop: 6, display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 15 }}>
          <span>Total</span><span>{p(invoice.total_paise)}</span>
        </div>
      </div>

      <p style={{ fontSize: 11, color: '#777', marginTop: 28 }}>
        Amounts are GST-inclusive. This is a computer-generated tax invoice.
      </p>
    </Shell>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
      <span style={{ color: '#555' }}>{label}</span><span>{value}</span>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  // Deliberately light/white — an invoice is printed. Self-contained colours.
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '40px 28px', background: '#fff', color: '#111', minHeight: '100vh' }}>
      {children}
    </main>
  )
}

const rule: React.CSSProperties = { border: 0, borderTop: '1px solid #ddd', margin: '18px 0' }
const th: React.CSSProperties = { borderBottom: '2px solid #111', padding: '6px 8px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#333' }
const td: React.CSSProperties = { borderBottom: '1px solid #eee', padding: '6px 8px' }
