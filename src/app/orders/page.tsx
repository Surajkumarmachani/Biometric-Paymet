import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import { SignInButton } from '@clerk/nextjs'
import { sql } from '@/lib/db'
import { toPaise, formatINR } from '@/lib/money'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Customer order history.
 *
 * Before this page a payment confirmation was transient — once you left the
 * checkout screen there was no way back to your receipt. Customer-scoped: the
 * query filters on the Clerk subject (service-role read, so we filter here).
 */

interface Row {
  id: string
  status: string
  amount_paise: string
  amount_refunded_paise: string
  receipt_no: string | null
  created_at: string
  invoice_no: string | null
  refund_request_status: string | null
}

const STATUS: Record<string, { cls: string; label: string }> = {
  paid:              { cls: 'badge-good badge-tick', label: 'Paid' },
  refunded:          { cls: 'badge-neutral', label: 'Refunded' },
  payment_failed:    { cls: 'badge-danger',  label: 'Failed' },
  awaiting_payment:  { cls: 'badge-warn',    label: 'Awaiting payment' },
  abandoned:         { cls: 'badge-neutral', label: 'Not completed' },
  disputed:          { cls: 'badge-danger',  label: 'Disputed' },
  charged_back:      { cls: 'badge-danger',  label: 'Charged back' },
  draft:             { cls: 'badge-neutral', label: 'Incomplete' },
  claimed:           { cls: 'badge-neutral', label: 'Incomplete' },
  intent_verified:   { cls: 'badge-neutral', label: 'Incomplete' },
}

export default async function OrdersPage() {
  const { userId } = await auth()

  if (!userId) {
    return (
      <div className="page">
        <div className="container container-sm stack">
          <p className="eyebrow">Orders</p>
          <h1 className="display h-page">Sign in to see your orders</h1>
          <div>
            <SignInButton mode="modal">
              <button className="btn btn-primary btn-lg">Sign in</button>
            </SignInButton>
          </div>
        </div>
      </div>
    )
  }

  /*
   * The latest refund request per order, so the list can say "awaiting review"
   * without the customer having to open each order to find out. A lateral join
   * rather than a plain one: an order can accumulate several requests over time
   * (ask, withdraw, ask again) and a plain join would duplicate the row.
   */
  const rows = (await sql`
    select o.id, o.status, o.amount_paise, o.amount_refunded_paise,
           o.receipt_no, o.created_at, i.invoice_no,
           rr.status as refund_request_status
      from orders o
      left join invoices i on i.order_id = o.id
      left join lateral (
        select status
          from refund_requests
         where order_id = o.id
         order by created_at desc
         limit 1
      ) rr on true
     where o.user_id = ${userId}
     order by o.created_at desc
     limit 50
  `) as unknown as Row[]

  const paidCount = rows.filter((r) => r.status === 'paid' || r.status === 'refunded').length

  return (
    <div className="page-tight">
      <div className="container container-md">
        <div className="row-between row-wrap" style={{ marginBottom: 'var(--s6)' }}>
          <div className="stack-2">
            <p className="eyebrow">Orders</p>
            <h1 className="display h-page">Your orders</h1>
          </div>
          <Link href="/checkout" className="btn btn-secondary">New checkout</Link>
        </div>

        {rows.length === 0 ? (
          <div className="card card-raised">
            <div className="empty stack" style={{ alignItems: 'center' }}>
              <p className="h-section">No orders yet</p>
              <p className="small" style={{ maxWidth: '36ch' }}>
                When you complete a checkout it&rsquo;ll appear here with its receipt
                and GST invoice.
              </p>
              <Link href="/checkout" className="btn btn-primary">Start a checkout</Link>
            </div>
          </div>
        ) : (
          <>
            <div className="card card-flush card-raised">
              <div className="card-head">
                <span className="card-title">
                  {rows.length} order{rows.length === 1 ? '' : 's'}
                </span>
                <span className="card-title">{paidCount} completed</span>
              </div>

              <ul>
                {rows.map((r) => {
                  const s = STATUS[r.status] ?? { cls: 'badge-neutral', label: r.status.replace(/_/g, ' ') }
                  const amount = toPaise(r.amount_paise)
                  const refunded = toPaise(r.amount_refunded_paise)
                  const isPaid = r.status === 'paid' || r.status === 'refunded'
                  const when = new Date(r.created_at).toLocaleString('en-IN', {
                    timeZone: 'Asia/Kolkata',
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })

                  const inner = (
                    <>
                      <div className="stack-2" style={{ gap: 3, minWidth: 0 }}>
                        <div className="row" style={{ gap: 'var(--s3)' }}>
                          <span className={`badge ${s.cls}`}>{s.label}</span>
                          {refunded > 0 && r.status === 'paid' && (
                            <span className="badge badge-neutral badge-plain">
                              {formatINR(refunded)} refunded
                            </span>
                          )}
                          {r.refund_request_status === 'pending' && (
                            <span className="badge badge-warn">Refund requested</span>
                          )}
                          {r.refund_request_status === 'declined' && (
                            <span className="badge badge-neutral badge-plain">
                              Refund declined
                            </span>
                          )}
                        </div>
                        <span className="tiny faint">
                          {when}
                          {r.receipt_no ? ` · Receipt ${r.receipt_no}` : ''}
                          {r.invoice_no ? ` · ${r.invoice_no}` : ''}
                        </span>
                      </div>
                      <div className="row" style={{ gap: 'var(--s4)' }}>
                        <span className="amount" style={{ fontWeight: 600 }}>
                          {formatINR(amount)}
                        </span>
                        {isPaid && <span className="faint" aria-hidden="true">›</span>}
                      </div>
                    </>
                  )

                  // Opens the order, not the tax invoice. The invoice is a
                  // legal document reached from the order detail — sending
                  // someone straight to a GST layout when they tapped "what did
                  // I buy" was answering a question nobody asked.
                  return (
                    <li key={r.id}>
                      {isPaid ? (
                        <Link href={`/orders/${r.id}`} className="link-row">
                          {inner}
                        </Link>
                      ) : (
                        <div className="link-row" style={{ cursor: 'default' }}>{inner}</div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>

            <p className="tiny faint center" style={{ marginTop: 'var(--s4)' }}>
              Tap a completed order to see its items, receipt and GST invoice.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
