'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useReverification } from '@clerk/nextjs'
import { isReverificationHint } from '@/lib/reverification'

/**
 * Staff order list with the refund action.
 *
 * A refund needs a fresh passkey step-up, so the fetch is wrapped in
 * useReverification and the route returns Clerk's reverification hint (not a
 * plain 403) — returning the hint is what lets the hook pop the prompt and retry.
 */

export interface StaffOrder {
  id: string
  status: string
  amountDisplay: string
  capturedDisplay: string
  refundedDisplay: string
  /** Refund accepted by Razorpay but not yet settled, if any. */
  pendingDisplay: string | null
  remainingPaise: number
  remainingDisplay: string
  receiptNo: string | null
  email: string | null
  inStore: boolean
  at: string
  refundable: boolean
  /** The customer's open ask, if they made one. */
  refundRequest: {
    id: string
    amountPaise: number
    amountDisplay: string
    reason: string
    at: string
  } | null
}

const STATUS: Record<string, string> = {
  paid: 'badge-good',
  refunded: 'badge-neutral',
  payment_failed: 'badge-danger',
  awaiting_payment: 'badge-warn',
  abandoned: 'badge-neutral',
  disputed: 'badge-danger',
  charged_back: 'badge-danger',
}

export default function StaffOrdersClient({
  orders,
  canRefund,
  query,
}: {
  orders: StaffOrder[]
  canRefund: boolean
  query: string
}) {
  const router = useRouter()
  const [q, setQ] = useState(query)
  const [openId, setOpenId] = useState<string | null>(null)

  function search(e: React.FormEvent) {
    e.preventDefault()
    router.push(q.trim() ? `/staff/orders?q=${encodeURIComponent(q.trim())}` : '/staff/orders')
  }

  return (
    <div className="stack-6">
      <form onSubmit={search} className="row row-wrap">
        <input
          className="input"
          style={{ maxWidth: 340 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Receipt number or order ID"
          aria-label="Search orders"
        />
        <button type="submit" className="btn btn-secondary">Search</button>
        {query && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => { setQ(''); router.push('/staff/orders') }}
          >
            Clear
          </button>
        )}
      </form>

      {orders.length === 0 ? (
        <div className="card card-raised">
          <div className="empty stack" style={{ alignItems: 'center' }}>
            <p className="h-section">No orders found</p>
            <p className="small">
              {query
                ? `Nothing matches “${query}”. Try the full receipt number.`
                : 'Orders will appear here once customers start paying.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="card card-flush card-raised">
          <div className="card-head">
            <span className="card-title">
              {query ? `Results for “${query}”` : 'Recent orders'}
            </span>
            <span className="card-title">{orders.length}</span>
          </div>

          <ul>
            {orders.map((o) => (
              <li key={o.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="link-row" style={{ borderBottom: 0, cursor: 'default' }}>
                  <div className="stack-2" style={{ gap: 3, minWidth: 0 }}>
                    <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
                      <span className={`badge ${STATUS[o.status] ?? 'badge-neutral'}`}>
                        {o.status.replace(/_/g, ' ')}
                      </span>
                      <span className="badge badge-neutral badge-plain">
                        {o.inStore ? 'in store' : 'web'}
                      </span>
                      {o.refundedDisplay !== '₹0.00' && (
                        <span className="badge badge-warn badge-plain">
                          {o.refundedDisplay} refunded
                        </span>
                      )}
                      {o.pendingDisplay && (
                        <span className="badge badge-warn">
                          {o.pendingDisplay} refund pending
                        </span>
                      )}
                      {o.refundRequest && (
                        <span className="badge badge-gold">
                          {o.refundRequest.amountDisplay} refund requested
                        </span>
                      )}
                    </div>
                    <span className="tiny faint">
                      {o.at}
                      {o.receiptNo ? ` · ${o.receiptNo}` : ''}
                      {o.email ? ` · ${o.email}` : ''}
                    </span>
                    <span className="tiny faint mono">{o.id}</span>
                    {o.refundRequest && (
                      <span className="tiny" style={{ color: 'var(--gold)' }}>
                        Customer asked {o.refundRequest.at}: “{o.refundRequest.reason}”
                      </span>
                    )}
                  </div>

                  <div className="row" style={{ gap: 'var(--s4)' }}>
                    <span className="amount" style={{ fontWeight: 600 }}>{o.amountDisplay}</span>
                    {canRefund && (o.refundable || o.refundRequest) && (
                      <button
                        className={`btn btn-sm ${o.refundRequest ? 'btn-primary' : 'btn-danger'}`}
                        onClick={() => setOpenId(openId === o.id ? null : o.id)}
                      >
                        {openId === o.id
                          ? 'Cancel'
                          : o.refundRequest
                            ? 'Review request'
                            : 'Refund'}
                      </button>
                    )}
                  </div>
                </div>

                {canRefund && openId === o.id && (
                  <RefundForm
                    order={o}
                    onDone={() => { setOpenId(null); router.refresh() }}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!canRefund && (
        <div className="notice notice-info">
          <span aria-hidden="true">ℹ</span>
          <span>Refunds require the manager role.</span>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- refund -- */

function RefundForm({ order, onDone }: { order: StaffOrder; onDone: () => void }) {
  const ask = order.refundRequest

  /*
   * Seeded from the customer's request when there is one. Retyping an amount
   * and a reason that are already on screen is how a ₹6 request becomes a ₹600
   * refund, so the ask is the default and staff edit it rather than re-enter it.
   * A request for less than the full remaining balance opens in partial mode.
   */
  const asksForPart = !!ask && ask.amountPaise < order.remainingPaise
  const [mode, setMode] = useState<'full' | 'partial'>(asksForPart ? 'partial' : 'full')
  const [rupees, setRupees] = useState(
    asksForPart ? (ask!.amountPaise / 100).toFixed(2) : '',
  )
  const [reason, setReason] = useState(ask ? ask.reason : '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<string | null>(null)

  // Wrapped so a missing step-up pops the passkey prompt and retries.
  const submitRefund = useReverification(
    async (body: { amountPaise?: number; reason: string }) => {
      const res = await fetch(`/api/orders/${order.id}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => null)
      if (res.ok) return data
      if (isReverificationHint(data)) return data
      throw new Error(data?.error?.message ?? 'Refund failed.')
    },
  )

  /**
   * Declining moves no money, so no step-up and no useReverification wrapper —
   * the manager gate on the route is the whole control. The note goes back to
   * the customer verbatim, which is why it is a separate field from the refund
   * reason: one is for them, the other is recorded on the refund.
   */
  async function decline() {
    if (!ask) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/staff/refund-requests/${ask.id}/decline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: note.trim() || undefined }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(data?.error?.message ?? 'Could not decline that request.')
        return
      }
      setDone('Request declined. The customer can see your note on their order.')
      setTimeout(onDone, 1600)
    } catch {
      setError('Network error. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const partialPaise = Math.round(Number(rupees) * 100)
  const partialInvalid =
    mode === 'partial' &&
    (!Number.isFinite(partialPaise) || partialPaise <= 0 || partialPaise > order.remainingPaise)

  async function submit() {
    setBusy(true); setError('')
    try {
      const result = await submitRefund({
        ...(mode === 'partial' ? { amountPaise: partialPaise } : {}),
        reason: reason.trim() || 'staff refund',
      })
      // A hint came back instead of a result only if the user cancelled the
      // step-up; treat anything without a refundId as unfinished.
      if (!result?.refundId) {
        setError('Refund not completed — the confirmation was cancelled.')
        return
      }
      const total = formatInr(Number(result.amountRefundedPaise ?? 0))
      const requested = formatInr(Number(result.requestedPaise ?? 0))
      // 'pending' is the common test-mode answer: Razorpay accepted the refund
      // but hasn't moved the money, so nothing counts as refunded yet.
      setDone(
        result.refundStatus === 'pending'
          ? `Refund of ${requested} requested. Razorpay is still processing it — the order will show as refunded once the refund.processed webhook arrives.`
          : result.fullyRefunded
            ? `Fully refunded — ${total} returned.`
            : `Partial refund recorded — ${total} returned so far.`,
      )
      setTimeout(onDone, result.refundStatus === 'pending' ? 4000 : 1600)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        /cancel/i.test(msg)
          ? 'You cancelled the confirmation. Nothing was refunded.'
          : msg,
      )
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div style={{ padding: '0 var(--s5) var(--s4)' }}>
        <div className="notice notice-good">
          <span aria-hidden="true">✓</span>
          <span>{done}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className="stack"
      style={{
        padding: 'var(--s4) var(--s5) var(--s5)',
        background: 'var(--surface-2)',
        borderTop: '1px solid var(--border)',
      }}
    >
      {ask && (
        <div className="notice notice-info">
          <span aria-hidden="true">ℹ</span>
          <span>
            The customer requested <strong>{ask.amountDisplay}</strong> on {ask.at} —
            “{ask.reason}”. Refunding below answers it; declining sends them a note.
          </span>
        </div>
      )}

      <div className="dl">
        <div className="dl-row"><dt>Captured</dt><dd>{order.capturedDisplay}</dd></div>
        <div className="dl-row"><dt>Already refunded</dt><dd>{order.refundedDisplay}</dd></div>
        {order.pendingDisplay && (
          <div className="dl-row">
            <dt style={{ color: 'var(--warn)' }}>Refund pending</dt>
            <dd style={{ color: 'var(--warn)' }}>{order.pendingDisplay}</dd>
          </div>
        )}
        <div className="dl-row"><dt>Available to refund</dt><dd>{order.remainingDisplay}</dd></div>
      </div>

      {/* Nothing left to refund but an open request still needs an answer, so
          the decline path below stays available on its own. */}
      {!order.refundable ? (
        <div className="notice notice-warn">
          <span aria-hidden="true">!</span>
          <span>
            There is nothing left to refund on this order
            {ask ? ' — you can still decline the request below.' : '.'}
          </span>
        </div>
      ) : (
      <>
      <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
        <button
          className={`btn btn-sm ${mode === 'full' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setMode('full')}
          disabled={busy}
        >
          Full — {order.remainingDisplay}
        </button>
        <button
          className={`btn btn-sm ${mode === 'partial' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setMode('partial')}
          disabled={busy}
        >
          Partial
        </button>
      </div>

      {mode === 'partial' && (
        <div className="field" style={{ maxWidth: 220 }}>
          <label className="label" htmlFor={`amt-${order.id}`}>Amount in rupees</label>
          <input
            id={`amt-${order.id}`}
            className="input amount"
            value={rupees}
            onChange={(e) => setRupees(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.00"
            inputMode="decimal"
            disabled={busy}
          />
          {partialInvalid && rupees !== '' && (
            <span className="tiny" style={{ color: 'var(--danger)' }}>
              Must be more than zero and at most {order.remainingDisplay}.
            </span>
          )}
        </div>
      )}

      <div className="field">
        <label className="label" htmlFor={`why-${order.id}`}>Reason (recorded on the refund)</label>
        <input
          id={`why-${order.id}`}
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 200))}
          placeholder="Customer returned the item"
          disabled={busy}
        />
      </div>

      <div className="notice notice-warn">
        <span aria-hidden="true">!</span>
        <span>
          This moves money back to the customer and issues a GST credit note. You
          will be asked to confirm with your passkey.
        </span>
      </div>

      <div>
        <button
          className="btn btn-danger"
          onClick={() => void submit()}
          disabled={busy || partialInvalid}
        >
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? 'Refunding…' : mode === 'full' ? `Refund ${order.remainingDisplay}` : 'Refund this amount'}
        </button>
      </div>
      </>
      )}

      {ask && (
        <div
          className="stack"
          style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--s4)' }}
        >
          <div className="field">
            <label className="label" htmlFor={`note-${order.id}`}>
              Or decline, with a note the customer will see
            </label>
            <input
              id={`note-${order.id}`}
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 200))}
              placeholder="Worn items can't be returned after 30 days"
              disabled={busy}
            />
          </div>
          <div>
            <button className="btn btn-secondary" onClick={() => void decline()} disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? 'Declining…' : 'Decline request'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="notice notice-danger">
          <span aria-hidden="true">!</span>
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}

function formatInr(paise: number): string {
  const rupees = Math.floor(paise / 100)
  const frac = String(paise % 100).padStart(2, '0')
  const s = String(rupees)
  const grouped =
    s.length <= 3 ? s : `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`
  return `₹${grouped}.${frac}`
}
