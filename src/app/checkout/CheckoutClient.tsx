'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import Script from 'next/script'
import { SignedIn, SignedOut, SignInButton, useReverification } from '@clerk/nextjs'
import { isReverificationHint } from '@/lib/reverification'
import OrderTile from '../staff/terminal/OrderTile'
import { apiFetch } from '@/lib/api-client'

/**
 * Customer self-checkout flow.
 *
 *   1. POST /api/orders          — server prices {sku, qty} from product_prices
 *   2. POST /api/pay/authorize   — Clerk passkey step-up, then Razorpay order
 *   3. Razorpay Standard Checkout — UPI intent on mobile, card/QR on desktop
 *   4. POST /api/pay/confirm      — advisory fast path to "paid"
 *   5. poll /api/orders/:id/status + a live Realtime tile (the truth path)
 */

export interface CatalogItem {
  sku: string
  name: string
  amountPaise: number
  amountDisplay: string
  currency: string
  /** Above the risk-layer per-order cap, so it cannot be ordered online. */
  overCap?: boolean
}

type Phase =
  | 'cart'
  | 'creating'
  | 'authorizing'
  | 'checkout'
  | 'confirming'
  | 'paid'
  | 'failed'

interface AuthorizeResponse {
  orderId: string
  razorpayOrderId: string
  amountPaise: number
  amountDisplay: string
  currency: string
  razorpayKeyId?: string
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void }
  }
}

const PHASE_LABEL: Record<Phase, string> = {
  cart: '',
  creating: 'Creating your order…',
  authorizing: 'Confirm with your passkey…',
  checkout: 'Choose how to pay…',
  confirming: 'Confirming your payment…',
  paid: 'Paid',
  failed: '',
}

export default function CheckoutClient({
  catalog,
  capDisplay,
}: {
  catalog: CatalogItem[]
  capDisplay: string
}) {
  const [qty, setQty] = useState<Record<string, number>>({})
  const [phase, setPhase] = useState<Phase>('cart')
  const [message, setMessage] = useState('')
  const [order, setOrder] = useState<{ id: string; amountDisplay: string } | null>(null)
  const [receiptNo, setReceiptNo] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lines = useMemo(
    () =>
      Object.entries(qty)
        .filter(([, q]) => q > 0)
        .map(([sku, q]) => ({ sku, qty: q })),
    [qty],
  )

  const selected = useMemo(
    () => catalog.filter((i) => (qty[i.sku] ?? 0) > 0),
    [catalog, qty],
  )

  const totalPaise = useMemo(
    () => catalog.reduce((sum, item) => sum + item.amountPaise * (qty[item.sku] ?? 0), 0),
    [catalog, qty],
  )

  const totalDisplay = useMemo(() => formatInr(totalPaise), [totalPaise])
  const busy = phase !== 'cart' && phase !== 'failed'

  const authorize = useReverification(
    async (orderId: string): Promise<AuthorizeResponse> => {
      const res = await apiFetch('/api/pay/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok) return data as AuthorizeResponse
      // Returning the hint (not throwing) is what lets useReverification pop the
      // step-up UI and retry this fetch once verification succeeds.
      if (isReverificationHint(data)) return data as unknown as AuthorizeResponse
      throw new Error(data?.error?.message ?? 'authorize failed')
    },
  )

  const poll = useCallback(async (orderId: string, attempt = 0) => {
    try {
      const res = await apiFetch(`/api/orders/${orderId}/status`, { cache: 'no-store' })
      const data = await res.json()
      if (data.paid) {
        setPhase('paid')
        setReceiptNo(data.receiptNo ?? null)
        return
      }
      if (data.settled) {
        setPhase('failed')
        setMessage('That payment didn’t go through. You can try again.')
        return
      }
    } catch {
      // transient — keep polling
    }
    if (attempt > 90) {
      setMessage(
        'Still confirming with your bank. We’ll email you when it settles — you can close this page.',
      )
      return
    }
    const delay = attempt < 6 ? 2000 : attempt < 20 ? 5000 : 10000
    pollTimer.current = setTimeout(() => void poll(orderId, attempt + 1), delay)
  }, [])

  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current) }, [])

  async function start() {
    if (lines.length === 0) return
    setMessage('')
    try {
      setPhase('creating')
      const res = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lines, idempotencyKey: crypto.randomUUID() }),
      })
      if (!res.ok) {
        const body = await res.json()
        setPhase('failed')
        setMessage(body?.error?.message ?? 'Could not create the order.')
        return
      }
      const created = await res.json()
      setOrder({ id: created.orderId, amountDisplay: created.amountDisplay })

      setPhase('authorizing')
      const auth = await authorize(created.orderId)

      setPhase('checkout')
      openCheckout(auth)
    } catch (err) {
      setPhase('failed')
      setMessage(friendlyError(err))
    }
  }

  function openCheckout(auth: AuthorizeResponse) {
    if (!window.Razorpay) {
      setPhase('failed')
      setMessage('Payment library didn’t load. Check your connection and retry.')
      return
    }
    const rzp = new window.Razorpay({
      key: auth.razorpayKeyId,
      order_id: auth.razorpayOrderId,
      currency: auth.currency,
      name: 'REGAL LAB',
      description: auth.amountDisplay,
      callback_url: `${window.location.origin}/checkout`,
      redirect: false,
      handler: async (response: {
        razorpay_order_id: string
        razorpay_payment_id: string
        razorpay_signature: string
      }) => {
        setPhase('confirming')
        try {
          const res = await apiFetch('/api/pay/confirm', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(response),
          })
          const data = await res.json()
          if (data.paid) {
            setPhase('paid')
            setReceiptNo(data.receiptNo ?? null)
            return
          }
        } catch {
          // fall through to polling
        }
        void poll(auth.orderId)
      },
      modal: {
        // Switching to a UPI app looks like a dismissal — never a failure.
        ondismiss: () => {
          setPhase('confirming')
          void poll(auth.orderId)
        },
        escape: false,
        backdropclose: false,
      },
      theme: { color: '#c8a04a' },
    })
    rzp.open()
  }

  function reset() {
    setQty({})
    setOrder(null)
    setReceiptNo(null)
    setMessage('')
    setPhase('cart')
  }

  /* ------------------------------------------------------------- paid view -- */
  if (phase === 'paid') {
    return (
      <div className="container-sm" style={{ padding: 0 }}>
        <div className="card card-raised stack center" style={{ alignItems: 'center' }}>
          <span className="badge badge-good">PAID</span>
          <p className="amount-xl gold" style={{ margin: 0 }}>
            {order?.amountDisplay ?? totalDisplay}
          </p>
          {receiptNo && (
            <p className="mono small muted">Receipt {receiptNo}</p>
          )}
          <p className="small muted" style={{ maxWidth: '38ch' }}>
            Thank you. Your payment is confirmed and a GST invoice has been issued.
          </p>
          <div className="row row-wrap center" style={{ justifyContent: 'center' }}>
            {order && (
              <Link href={`/orders/${order.id}/invoice`} className="btn btn-primary">
                View invoice
              </Link>
            )}
            <Link href="/orders" className="btn btn-secondary">My orders</Link>
            <button className="btn btn-ghost" onClick={reset}>Buy something else</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="afterInteractive" />

      <SignedOut>
        <div className="card stack">
          <p className="muted">Please sign in to check out.</p>
          <div>
            <SignInButton mode="modal">
              <button className="btn btn-primary">Sign in</button>
            </SignInButton>
          </div>
        </div>
      </SignedOut>

      <SignedIn>
        <div className="split">
          {/* ------------------------------------------------------ catalog -- */}
          <div className="card card-flush card-raised">
            <div className="card-head">
              <span className="card-title">Available now</span>
              <span className="card-title">{catalog.length} items</span>
            </div>
            <ul className="list" style={{ padding: '0 var(--s5)' }}>
              {catalog.map((item) => {
                const n = qty[item.sku] ?? 0
                return (
                  <li key={item.sku} className="list-row">
                    <div className="stack-2" style={{ gap: 2, minWidth: 0 }}>
                      <span className="h-card">{item.name}</span>
                      <span className="tiny faint mono">{item.sku}</span>
                      {item.overCap && (
                        <span className="tiny" style={{ color: 'var(--warn)' }}>
                          Over the {capDisplay} online limit — buy in store
                        </span>
                      )}
                    </div>
                    <div className="row" style={{ gap: 'var(--s5)' }}>
                      <span className="amount small" style={{ color: n > 0 ? 'var(--gold)' : 'var(--text-muted)' }}>
                        {item.amountDisplay}
                      </span>
                      <div className="stepper">
                        <button
                          className="stepper-btn"
                          disabled={busy || n === 0}
                          onClick={() => setQty((q) => ({ ...q, [item.sku]: Math.max(0, n - 1) }))}
                          aria-label={`Remove one ${item.name}`}
                        >
                          −
                        </button>
                        <span className="stepper-value">{n}</span>
                        <button
                          className="stepper-btn"
                          disabled={busy || n >= 99 || item.overCap}
                          onClick={() => setQty((q) => ({ ...q, [item.sku]: Math.min(99, n + 1) }))}
                          aria-label={`Add one ${item.name}`}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>

          {/* ------------------------------------------------------ summary -- */}
          <aside className="sticky-aside stack">
            <div className="card card-raised stack">
              <span className="card-title">Order summary</span>

              {selected.length === 0 ? (
                <p className="small faint">Nothing selected yet.</p>
              ) : (
                <dl className="dl">
                  {selected.map((item) => (
                    <div key={item.sku} className="dl-row">
                      <dt>
                        {item.name}
                        {(qty[item.sku] ?? 0) > 1 && (
                          <span className="faint"> × {qty[item.sku]}</span>
                        )}
                      </dt>
                      <dd>{formatInr(item.amountPaise * (qty[item.sku] ?? 0))}</dd>
                    </div>
                  ))}
                </dl>
              )}

              <div className="dl-total">
                <span>Total</span>
                <span className="amount">{totalDisplay}</span>
              </div>

              {phase === 'confirming' && order ? (
                <div className="stack center" style={{ alignItems: 'center' }}>
                  <OrderTile
                    orderId={order.id}
                    amountDisplay={order.amountDisplay}
                    initialStatus="awaiting_payment"
                  />
                  <p className="small muted">
                    {message || 'Finish in your payment app if it’s still open. Don’t close this page.'}
                  </p>
                </div>
              ) : (
                <>
                  <button
                    className="btn btn-primary btn-lg btn-block"
                    onClick={() => void start()}
                    disabled={lines.length === 0 || busy}
                  >
                    {busy && <span className="spinner" aria-hidden="true" />}
                    {phase === 'cart' && (lines.length === 0 ? 'Select an item' : `Pay ${totalDisplay}`)}
                    {phase === 'failed' && `Try again — ${totalDisplay}`}
                    {busy && PHASE_LABEL[phase]}
                  </button>

                  {message ? (
                    <div className="notice notice-danger">
                      <span aria-hidden="true">!</span>
                      <span>{message}</span>
                    </div>
                  ) : (
                    <p className="tiny faint center">
                      A passkey step-up is required for every payment. Your bank or UPI
                      app performs the final confirmation.
                    </p>
                  )}
                </>
              )}
            </div>

            <p className="tiny faint center">
              Online orders are capped at {capDisplay} per order.
            </p>
          </aside>
        </div>
      </SignedIn>
    </>
  )
}

/* Indian digit grouping, client-side (money.ts is server-only). */
function formatInr(paise: number): string {
  const rupees = Math.floor(paise / 100)
  const frac = String(paise % 100).padStart(2, '0')
  const s = String(rupees)
  const grouped =
    s.length <= 3 ? s : `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`
  return `₹${grouped}.${frac}`
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/reverification_cancelled|cancelled/i.test(msg)) {
    return 'You cancelled the confirmation. Tap Pay to try again.'
  }
  return msg || 'Something went wrong.'
}
