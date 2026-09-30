import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import { SignInButton } from '@clerk/nextjs'
import { requireStaff, staffMayRefund } from '@/lib/auth'
import { sql } from '@/lib/db'
import { toPaise, formatINR } from '@/lib/money'
import { openRequestsByOrder } from '@/lib/refund-request'
import StaffOrdersClient, { type StaffOrder } from './StaffOrdersClient'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Staff order lookup + refunds.
 *
 * Scope: managers and admins can look up any order; associates see only their
 * store. Refunding is narrower (0017): managers refund their own store's orders,
 * admins any — the refund button follows staffMayRefund.
 * Either role can look an order up by receipt number — that is what happens when
 * a customer walks in holding one.
 */

interface Row {
  id: string
  status: string
  amount_paise: string
  amount_captured_paise: string
  amount_refunded_paise: string
  receipt_no: string | null
  created_at: string
  store_id: string | null
  email: string | null
  pending_refund_paise: string
}

export default async function StaffOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { userId } = await auth()
  if (!userId) {
    return (
      <Shell>
        <h1 className="display h-page">Staff sign-in required</h1>
        <div>
          <SignInButton mode="modal">
            <button className="btn btn-primary btn-lg">Sign in</button>
          </SignInButton>
        </div>
      </Shell>
    )
  }

  let staff: { storeId: string; role: 'associate' | 'manager' | 'admin' }
  try {
    const s = await requireStaff('associate')
    staff = { storeId: s.storeId, role: s.role }
  } catch {
    return (
      <Shell>
        <h1 className="display h-page">This account isn&rsquo;t staff</h1>
        <div className="notice notice-warn">
          <span aria-hidden="true">!</span>
          <span>Ask an admin to add you to a store, or use a staff account.</span>
        </div>
      </Shell>
    )
  }

  const canRefund = staff.role === 'manager' || staff.role === 'admin'
  const q = ((await searchParams)?.q ?? '').trim()
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)

  // pending_refund_paise: refunds Razorpay has accepted but not yet settled.
  // They do NOT count as refunded (that is processed-only, by design) but staff
  // must see them, and they block a second refund on the same payment.
  const select = sql`
    select o.id, o.status, o.amount_paise, o.amount_captured_paise,
           o.amount_refunded_paise, o.receipt_no, o.created_at, o.store_id,
           u.email,
           coalesce((select sum(r.amount_paise) from refunds r
                      where r.order_id = o.id and r.status = 'pending'), 0)::text
             as pending_refund_paise
      from orders o
      left join app_users u on u.clerk_id = o.user_id
  `

  // Associates search within their own store only; managers and admins see
  // every store (staffMaySee). The scope applies to EVERY branch — it used to
  // cover only the default list, so `?q=%` listed all stores with emails.
  const scope = canRefund ? sql`true` : sql`o.store_id = ${staff.storeId}::uuid`
  // Receipt numbers are plain text; % and _ in the query are literals, not
  // wildcards.
  const likeQ = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'

  let rows: Row[]
  if (isUuid) {
    rows = (await sql`${select} where o.id = ${q}::uuid and ${scope} limit 1`) as unknown as Row[]
  } else if (q) {
    rows = (await sql`
      ${select} where o.receipt_no ilike ${likeQ} and ${scope}
      order by o.created_at desc limit 50
    `) as unknown as Row[]
  } else {
    rows = (await sql`
      ${select} where ${scope}
      order by o.created_at desc limit 40
    `) as unknown as Row[]
  }

  /*
   * Open refund requests for the rows on screen. One query for the whole page
   * rather than one per row, and only the open ones — a decided request is
   * history and does not belong in a work queue.
   */
  const requests = await openRequestsByOrder(rows.map((r) => r.id))

  const orders: StaffOrder[] = rows.map((r) => {
    const captured = toPaise(r.amount_captured_paise)
    const refunded = toPaise(r.amount_refunded_paise)
    const pending = toPaise(r.pending_refund_paise)
    const req = requests.get(r.id) ?? null
    // Same rule as the refund route: committed = pending + processed.
    const remaining = Math.max(0, captured - refunded - pending)
    return {
      id: r.id,
      status: r.status,
      amountDisplay: formatINR(toPaise(r.amount_paise)),
      capturedDisplay: formatINR(captured),
      refundedDisplay: formatINR(refunded),
      pendingDisplay: pending > 0 ? formatINR(pending) : null,
      remainingPaise: remaining,
      remainingDisplay: formatINR(remaining),
      receiptNo: r.receipt_no,
      email: r.email,
      inStore: r.store_id !== null,
      mayAct: staffMayRefund(staff, r.store_id),
      at: new Date(r.created_at).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
      // Only a captured order with nothing already committed can be refunded. A
      // charged_back order is deliberately excluded — the bank already took it.
      refundable: r.status === 'paid' && remaining > 0,
      refundRequest: req
        ? {
            id: req.id,
            amountPaise: req.amountPaise,
            amountDisplay: req.amountDisplay,
            reason: req.reason,
            at: req.at,
          }
        : null,
    }
  })

  // Asked-for refunds float to the top: they are the only rows with someone
  // waiting on an answer. Ordering stays newest-first within each group.
  orders.sort((a, b) => Number(!!b.refundRequest) - Number(!!a.refundRequest))
  const openRequests = orders.filter((o) => o.refundRequest).length

  return (
    <div className="page-tight">
      <div className="container">
        <div className="row-between row-wrap" style={{ marginBottom: 'var(--s6)' }}>
          <div className="stack-2">
            <p className="eyebrow">Staff</p>
            <h1 className="display h-page">Orders &amp; refunds</h1>
            <p className="small muted">
              {canRefund
                ? staff.role === 'admin'
                  ? 'Look up any order by receipt number, and refund a captured payment.'
                  : 'Look up any order by receipt number. Refunds are for your own store’s orders.'
                : 'Orders for your store. Refunds require a manager.'}
            </p>
          </div>
          <div className="row">
            {openRequests > 0 && (
              <span className="badge badge-warn">
                {openRequests} refund request{openRequests === 1 ? '' : 's'}
              </span>
            )}
            <span className="badge badge-gold">{staff.role}</span>
            <Link href="/staff/terminal" className="btn btn-secondary btn-sm">Terminal</Link>
          </div>
        </div>

        <StaffOrdersClient orders={orders} canRefund={canRefund} query={q} />
      </div>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="page">
      <div className="container container-sm stack">
        <p className="eyebrow">Staff</p>
        {children}
      </div>
    </div>
  )
}
