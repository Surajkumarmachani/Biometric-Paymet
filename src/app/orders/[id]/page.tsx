import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import { SignInButton } from '@clerk/nextjs'
import { sql } from '@/lib/db'
import { staffRole } from '@/lib/auth'
import { toPaise, formatINR } from '@/lib/money'
import SuccessTick from '@/components/SuccessTick'
import CountUpAmount from './CountUpAmount'
import RefundRequestPanel from './RefundRequestPanel'
import { latestRefundRequest, refundablePaise } from '@/lib/refund-request'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One order, itemised — where a customer lands after paying.
 *
 * Until now the end of the flow was a transient "PAID" card: the right amount
 * and a receipt number, but no answer to "paid for *what*". On a three-line
 * order that is the first thing anyone checks, and the only page that listed
 * the items was the GST tax invoice — a legal document, laid out for a printer,
 * and a strange thing to throw at someone who just tapped a fingerprint.
 *
 * So this sits between them: what you bought, what it cost, that it went
 * through, and a link to the invoice when you actually want the tax document.
 *
 * Visible to the customer who owns it, or to staff (an associate settling a
 * question at the counter). Read via the service-role client, so the ownership
 * check happens here rather than in RLS — see the query below.
 */

interface Row {
  id: string
  status: string
  amount_paise: string
  amount_captured_paise: string
  amount_refunded_paise: string
  receipt_no: string | null
  created_at: string
  fulfilled_at: string | null
  line_items: unknown
  user_id: string | null
  invoice_no: string | null
}

const STATUS: Record<string, { cls: string; label: string; note?: string }> = {
  paid: { cls: 'badge-good badge-tick', label: 'Paid' },
  refunded: { cls: 'badge-neutral', label: 'Refunded', note: 'This order was refunded.' },
  payment_failed: {
    cls: 'badge-danger',
    label: 'Payment failed',
    note: 'That payment didn’t go through. Nothing was charged.',
  },
  awaiting_payment: {
    cls: 'badge-warn',
    label: 'Awaiting payment',
    note: 'We’re still confirming this with your bank.',
  },
  abandoned: { cls: 'badge-neutral', label: 'Not completed' },
  disputed: { cls: 'badge-danger', label: 'Disputed' },
  charged_back: { cls: 'badge-danger', label: 'Charged back' },
  draft: { cls: 'badge-neutral', label: 'Incomplete' },
  claimed: { cls: 'badge-neutral', label: 'Incomplete' },
  intent_verified: { cls: 'badge-neutral', label: 'Incomplete' },
}

function when(ts: string): string {
  return new Date(ts).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { userId } = await auth()

  if (!userId) {
    return (
      <Shell title="Sign in to see this order">
        <SignInButton mode="modal">
          <button className="btn btn-primary btn-lg">Sign in</button>
        </SignInButton>
      </Shell>
    )
  }

  // A malformed id must 404 like any other unknown order, not 500 on a failed
  // uuid cast.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <NotFound />

  const rows = (await sql`
    select o.id, o.status, o.amount_paise, o.amount_captured_paise,
           o.amount_refunded_paise, o.receipt_no, o.created_at, o.fulfilled_at,
           o.line_items, o.user_id, i.invoice_no
      from orders o
      left join invoices i on i.order_id = o.id
     where o.id = ${id}::uuid
     limit 1
  `) as unknown as Row[]

  const order = rows[0]
  if (!order) return <NotFound />

  // Staff need to open any order at the counter; everyone else sees only their
  // own. Same-shaped 404 either way — "exists but not yours" is not something a
  // stranger should be able to learn from the response.
  const isOwner = order.user_id === userId
  const viewerStaffRole = await staffRole(userId)
  if (!isOwner && !viewerStaffRole) return <NotFound />

  const s = STATUS[order.status] ?? {
    cls: 'badge-neutral',
    label: order.status.replace(/_/g, ' '),
  }
  const lines = Array.isArray(order.line_items)
    ? (order.line_items as Array<{ name?: string; sku?: string; qty?: number; line_paise?: number }>)
    : []

  const amount = toPaise(order.amount_paise)
  const refunded = toPaise(order.amount_refunded_paise)
  const isPaid = order.status === 'paid' || order.status === 'refunded'

  /*
   * Refund-request state. Fetched for the owner and for staff, but used
   * differently: the owner gets the panel that can open and withdraw a request,
   * staff get a read-only line telling them the customer has already asked (the
   * action lives on /staff/orders, which has the manager gate and the step-up).
   *
   * Only for a settled order — there is nothing to refund on one that never
   * captured, and asking would just be a confusing dead end.
   */
  const refundRequest = isPaid ? await latestRefundRequest(order.id) : null
  const refundable = order.status === 'paid' ? await refundablePaise(order.id) : 0

  return (
    <div className="page-tight">
      <div className="container container-sm stack-6">
        <header className="stack-2 center stagger">
          <p className="eyebrow">{isPaid ? 'Order confirmed' : 'Order'}</p>
          {isPaid && (
            <span style={{ margin: '0 auto' }}>
              <SuccessTick size={64} />
            </span>
          )}
          {isPaid ? (
            <CountUpAmount
              className="amount-xl gold"
              display={formatINR(amount)}
              paise={amount}
            />
          ) : (
            <p className="amount-xl gold" style={{ margin: 0 }}>
              {formatINR(amount)}
            </p>
          )}
          <div className="row" style={{ justifyContent: 'center', gap: 'var(--s3)' }}>
            <span className={`badge ${s.cls}`}>{s.label}</span>
            {refunded > 0 && order.status === 'paid' && (
              <span className="badge badge-neutral badge-plain">
                {formatINR(refunded)} refunded
              </span>
            )}
          </div>
          {s.note && <p className="small muted">{s.note}</p>}
        </header>

        {lines.length > 0 && (
          <section
            className="card card-flush card-raised anim-rise"
            style={{ animationDelay: '220ms' }}
          >
            <div className="card-head">
              <span className="card-title">What you paid for</span>
              <span className="card-title">
                {lines.length} item{lines.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul className="stagger" style={{ padding: '0 var(--s5)' }}>
              {lines.map((l, i) => (
                <li key={i} className="list-row" style={{ padding: 'var(--s3) 0' }}>
                  <span className="stack-2" style={{ gap: 2, minWidth: 0 }}>
                    <span className="small">
                      {l.name ?? l.sku}
                      {(l.qty ?? 1) > 1 && <span className="faint"> × {l.qty}</span>}
                    </span>
                    {l.sku && <span className="tiny faint mono">{l.sku}</span>}
                  </span>
                  <span className="amount small">{formatINR(Number(l.line_paise ?? 0))}</span>
                </li>
              ))}
              <li className="list-row" style={{ padding: 'var(--s4) 0' }}>
                <span className="small" style={{ fontWeight: 600 }}>
                  Total
                </span>
                <span className="amount" style={{ fontWeight: 600 }}>
                  {formatINR(amount)}
                </span>
              </li>
            </ul>
          </section>
        )}

        <section className="card stack-2 anim-rise" style={{ animationDelay: '300ms' }}>
          <div className="row-between">
            <span className="tiny faint">Placed</span>
            <span className="tiny mono">{when(order.created_at)}</span>
          </div>
          {order.receipt_no && (
            <div className="row-between">
              <span className="tiny faint">Receipt</span>
              <span className="tiny mono">{order.receipt_no}</span>
            </div>
          )}
          {order.invoice_no && (
            <div className="row-between">
              <span className="tiny faint">Invoice</span>
              <span className="tiny mono">{order.invoice_no}</span>
            </div>
          )}
          <div className="row-between">
            <span className="tiny faint">Order id</span>
            <span className="tiny mono faint">{order.id}</span>
          </div>
        </section>

        {isOwner && isPaid && (
          <div className="anim-rise" style={{ animationDelay: '340ms' }}>
            <RefundRequestPanel
              orderId={order.id}
              refundablePaise={refundable}
              refundableDisplay={formatINR(refundable)}
              request={refundRequest}
            />
          </div>
        )}

        {!isOwner && viewerStaffRole && refundRequest?.status === 'pending' && (
          <div className="notice notice-warn anim-rise" style={{ animationDelay: '340ms' }}>
            <span aria-hidden="true">!</span>
            <span>
              The customer requested a {refundRequest.amountDisplay} refund
              on {refundRequest.at} — “{refundRequest.reason}”. Action it from{' '}
              <Link href={`/staff/orders?q=${order.id}`} className="gold">
                Orders &amp; refunds
              </Link>
              .
            </span>
          </div>
        )}

        <div className="stack anim-rise" style={{ animationDelay: '380ms' }}>
          {isPaid && (
            <Link href={`/orders/${order.id}/invoice`} className="btn btn-secondary btn-block">
              View GST tax invoice
            </Link>
          )}
          {viewerStaffRole ? (
            /*
             * The terminal now jumps here by itself once a payment lands, which
             * means this page is where the next customer's sale starts. Without
             * a way back the associate is hunting through the nav with someone
             * waiting at the counter.
             */
            <Link href="/staff/terminal" className="btn btn-primary btn-block">
              Take the next payment
            </Link>
          ) : (
            <Link href="/orders" className="btn btn-ghost btn-block">
              All your orders
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

function NotFound() {
  return (
    <Shell title="Order not found">
      <p className="lede" style={{ margin: '0 auto' }}>
        This order doesn&rsquo;t exist, or it isn&rsquo;t yours to view.
      </p>
      <Link href="/orders" className="btn btn-secondary">
        Your orders
      </Link>
    </Shell>
  )
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="page">
      <div className="container container-sm stack center">
        <p className="eyebrow">Orders</p>
        <h1 className="display h-page">{title}</h1>
        {children}
      </div>
    </div>
  )
}
