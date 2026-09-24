'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { RefundRequest } from '@/lib/refund-request'

/**
 * Where the customer asks for a refund.
 *
 * It asks; it does not refund. Nothing here moves money — a manager does that
 * through the staff refund path, which is why the copy says "request" and
 * "review" throughout and never implies the money is on its way.
 *
 * The four states this has to render are all real and all reachable:
 *   nothing yet          -> the form
 *   pending              -> what was asked, and a way to take it back
 *   declined             -> the reason, and the option to ask again
 *   approved / withdrawn -> a closed record, no form
 */

export default function RefundRequestPanel({
  orderId,
  refundablePaise,
  refundableDisplay,
  request,
}: {
  orderId: string
  refundablePaise: number
  refundableDisplay: string
  /** The latest request on this order, whatever its status. */
  request: RefundRequest | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'full' | 'partial'>('full')
  const [rupees, setRupees] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const pending = request?.status === 'pending'
  const canAsk = refundablePaise > 0 && !pending

  const partialPaise = Math.round(Number(rupees) * 100)
  const partialInvalid =
    mode === 'partial' &&
    (!Number.isFinite(partialPaise) || partialPaise <= 0 || partialPaise > refundablePaise)

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/orders/${orderId}/refund-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(mode === 'partial' ? { amountPaise: partialPaise } : {}),
          reason: reason.trim(),
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(data?.error?.message ?? 'Could not send that request.')
        return
      }
      setOpen(false)
      setReason('')
      setRupees('')
      // The panel is server-rendered from the request row, so a refresh is what
      // swaps the form for the pending card.
      router.refresh()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function withdraw() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/orders/${orderId}/refund-request`, { method: 'DELETE' })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(data?.error?.message ?? 'Could not withdraw that request.')
        return
      }
      router.refresh()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  /* ------------------------------------------------------------- pending -- */
  if (pending && request) {
    return (
      <section className="card stack">
        <div className="row-between row-wrap">
          <span className="card-title">Refund requested</span>
          <span className="badge badge-warn">Awaiting review</span>
        </div>

        <div className="dl">
          <div className="dl-row">
            <dt>Amount requested</dt>
            <dd>{request.amountDisplay}</dd>
          </div>
          <div className="dl-row">
            <dt>Your reason</dt>
            <dd>{request.reason}</dd>
          </div>
          <div className="dl-row">
            <dt>Sent</dt>
            <dd>{request.at}</dd>
          </div>
        </div>

        <p className="tiny faint">
          Our team reviews this and refunds to your original payment method if
          approved. You&rsquo;ll see the outcome on this page.
        </p>

        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => void withdraw()} disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? 'Withdrawing…' : 'Withdraw this request'}
          </button>
        </div>

        {error && (
          <div className="notice notice-danger">
            <span aria-hidden="true">!</span>
            <span>{error}</span>
          </div>
        )}
      </section>
    )
  }

  /* ------------------------------------------------ decided, nothing left -- */
  // A closed record with no refundable balance is the end of the story: show
  // what happened and offer nothing.
  if (request && !canAsk) {
    return (
      <section className="card stack">
        <span className="card-title">Refund</span>
        <ClosedNotice request={request} />
      </section>
    )
  }

  /* ------------------------------------------------------------ can ask --- */
  if (!canAsk) return null

  return (
    <section className="card stack">
      <div className="row-between row-wrap">
        <span className="card-title">Refund</span>
        <span className="tiny faint">{refundableDisplay} eligible</span>
      </div>

      {/* A previous decline stays visible above the form, so asking again is an
          informed choice rather than a shot in the dark. */}
      {request && <ClosedNotice request={request} />}

      {!open ? (
        <>
          <p className="small muted">
            Changed your mind, or something wrong with the item? Request a refund
            and our team will review it.
          </p>
          <div>
            <button className="btn btn-secondary" onClick={() => setOpen(true)}>
              Request a refund
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
            <button
              className={`btn btn-sm ${mode === 'full' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMode('full')}
              disabled={busy}
            >
              Full — {refundableDisplay}
            </button>
            <button
              className={`btn btn-sm ${mode === 'partial' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMode('partial')}
              disabled={busy}
            >
              Part of it
            </button>
          </div>

          {mode === 'partial' && (
            <div className="field" style={{ maxWidth: 220 }}>
              <label className="label" htmlFor="rr-amount">
                Amount in rupees
              </label>
              <input
                id="rr-amount"
                className="input amount"
                value={rupees}
                onChange={(e) => setRupees(e.target.value.replace(/[^\d.]/g, ''))}
                placeholder="0.00"
                inputMode="decimal"
                disabled={busy}
              />
              {partialInvalid && rupees !== '' && (
                <span className="tiny" style={{ color: 'var(--danger)' }}>
                  Must be more than zero and at most {refundableDisplay}.
                </span>
              )}
            </div>
          )}

          <div className="field">
            <label className="label" htmlFor="rr-reason">
              Why are you asking for a refund?
            </label>
            <input
              id="rr-reason"
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 200))}
              placeholder="The ring is the wrong size"
              disabled={busy}
            />
            <span className="tiny faint">
              Our team reads this, so a specific reason gets a faster answer.
            </span>
          </div>

          <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
            <button
              className="btn btn-primary"
              onClick={() => void submit()}
              disabled={busy || partialInvalid || reason.trim() === ''}
            >
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? 'Sending…' : 'Send request'}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setOpen(false)
                setError('')
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>

          <p className="tiny faint">
            This sends a request — it doesn&rsquo;t refund anything yet. Approved
            refunds go back to your original payment method.
          </p>
        </>
      )}

      {error && (
        <div className="notice notice-danger">
          <span aria-hidden="true">!</span>
          <span>{error}</span>
        </div>
      )}
    </section>
  )
}

/** The outcome of a request that is no longer open. */
function ClosedNotice({ request }: { request: RefundRequest }) {
  if (request.status === 'approved') {
    return (
      <div className="notice notice-good">
        <span aria-hidden="true">✓</span>
        <span>
          Your {request.amountDisplay} refund request was approved
          {request.decidedAt ? ` on ${request.decidedAt}` : ''}. It goes back to
          your original payment method — banks usually take 5–7 working days.
        </span>
      </div>
    )
  }

  if (request.status === 'declined') {
    return (
      <div className="notice notice-warn">
        <span aria-hidden="true">!</span>
        <span>
          Your {request.amountDisplay} refund request was declined
          {request.decidedAt ? ` on ${request.decidedAt}` : ''}.
          {request.decisionNote ? ` Reason: ${request.decisionNote}` : ''}
        </span>
      </div>
    )
  }

  // withdrawn
  return (
    <div className="notice notice-info">
      <span aria-hidden="true">ℹ</span>
      <span>You withdrew your earlier {request.amountDisplay} refund request.</span>
    </div>
  )
}
