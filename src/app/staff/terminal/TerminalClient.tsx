'use client'

import { useEffect, useMemo, useState } from 'react'
import OrderTile from './OrderTile'

/**
 * Associate-facing terminal. Build a cart -> POST /api/staff/orders -> render the
 * QR + a live OrderTile. The client sends only {sku, qty}; the amount is priced
 * server-side, same as every other entry point.
 */

export interface CatalogItem {
  sku: string
  name: string
  amountPaise: number
  amountDisplay: string
}

interface CreatedOrder {
  orderId: string
  amountDisplay: string
  qrUrl: string
  qrDataUrl: string
  expiresInSeconds: number
}

type Phase = 'building' | 'creating' | 'active'

/**
 * The live order survives a reload.
 *
 * A created order is valid server-side for its full claim TTL (15 minutes),
 * but it was only ever held in React state — so a refresh, a stray Cmd-R, or a
 * dev-server hot reload blanked the QR while the customer was mid-scan, and
 * the associate's only recourse was to build the cart again and issue a second
 * order for the same sale. The order itself was fine the whole time.
 *
 * sessionStorage, not localStorage: this is per-tab and dies with the tab,
 * which is the right lifetime for a till. Keyed with a version so a future
 * shape change can't be read back as garbage.
 */
const SESSION_KEY = 'regal.terminal.v1'

interface Saved {
  qty?: Record<string, number>
  order?: CreatedOrder
  /** Absolute epoch ms. A relative TTL is meaningless once you reload. */
  expiresAt?: number
}

export default function TerminalClient({ catalog }: { catalog: CatalogItem[] }) {
  const [qty, setQty] = useState<Record<string, number>>({})
  const [phase, setPhase] = useState<Phase>('building')
  const [order, setOrder] = useState<CreatedOrder | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [restored, setRestored] = useState(false)

  const lines = useMemo(
    () => Object.entries(qty).filter(([, q]) => q > 0).map(([sku, q]) => ({ sku, qty: q })),
    [qty],
  )
  const totalPaise = useMemo(
    () => catalog.reduce((s, i) => s + i.amountPaise * (qty[i.sku] ?? 0), 0),
    [catalog, qty],
  )
  const totalDisplay = formatInr(totalPaise)

  /**
   * Restore after mount rather than in a lazy useState initialiser: the server
   * has no sessionStorage, so seeding state during render would make the first
   * client render disagree with the server HTML and trip a hydration error.
   * One frame of empty cart is the cost.
   */
  useEffect(() => {
    let cancelled = false

    const restore = async () => {
      let saved: Saved | null = null
      try {
        const raw = sessionStorage.getItem(SESSION_KEY)
        if (raw) saved = JSON.parse(raw) as Saved
      } catch {
        saved = null
      }

      // Only bring back an order that still has time on it. A restored QR that
      // expired while the tab was closed would scan straight into a dead end.
      const stored = saved?.order
      const ticking = !!stored && !!saved?.expiresAt && saved.expiresAt > Date.now()

      /*
       * Time left on the clock is necessary but not sufficient: the claim token
       * is good for 15 minutes and a sale takes seconds, so a PAID order is
       * still "ticking" long after it is over. The terminal jumps to the order
       * the moment it settles, and "Take the next payment" comes straight back
       * here — restoring that order then puts the till into 'active', which
       * disables every stepper and re-shows a QR nobody can pay. The associate
       * cannot add an item for the next customer without knowing to press
       * "Start a new order" first.
       *
       * sessionStorage cannot know a status that changed after it was written,
       * so ask the server before trusting it. Awaited BEFORE any state is set,
       * so a stale order is never briefly rendered as live.
       */
      if (ticking && (await hasSettled(stored.orderId))) {
        try {
          sessionStorage.removeItem(SESSION_KEY)
        } catch {
          // Nothing to clean up.
        }
        if (!cancelled) setRestored(true)
        return
      }

      if (cancelled) return
      if (saved?.qty) setQty(saved.qty)
      if (ticking) {
        setOrder(stored)
        setExpiresAt(saved!.expiresAt!)
        setPhase('active')
      }
      setRestored(true)
    }

    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // Don't write until the restore pass has run, or the first render's empty
    // cart would overwrite what we were about to read back.
    if (!restored) return
    try {
      if (order && expiresAt) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ qty, order, expiresAt }))
      } else if (Object.values(qty).some((n) => n > 0)) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ qty }))
      } else {
        sessionStorage.removeItem(SESSION_KEY)
      }
    } catch {
      // Private mode, or a full quota. Persistence is a convenience; the sale
      // still works without it.
    }
  }, [restored, qty, order, expiresAt])

  async function createOrder() {
    if (lines.length === 0) return
    setPhase('creating'); setError('')
    try {
      const res = await fetch('/api/staff/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lines, idempotencyKey: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error?.message ?? 'Could not create the order.')
        setPhase('building')
        return
      }
      setOrder(data)
      setExpiresAt(Date.now() + data.expiresInSeconds * 1000)
      setPhase('active')
    } catch {
      setError('Network error. Try again.')
      setPhase('building')
    }
  }

  function reset() {
    setOrder(null); setExpiresAt(null); setQty({}); setError(''); setPhase('building')
    try { sessionStorage.removeItem(SESSION_KEY) } catch { /* nothing to clean up */ }
  }

  return (
    <div className="split">
      {/* ------------------------------------------------------ cart builder -- */}
      <div className="card card-flush card-raised">
        <div className="card-head">
          <span className="card-title">Build the order</span>
          <span className="card-title">{catalog.length} items</span>
        </div>

        <ul className="list stagger" style={{ padding: '0 var(--s5)' }}>
          {catalog.map((item) => {
            const n = qty[item.sku] ?? 0
            return (
              <li key={item.sku} className="list-row">
                <div className="stack-2" style={{ gap: 2, minWidth: 0 }}>
                  <span className="h-card">{item.name}</span>
                  <span className="tiny faint mono">{item.sku} · {item.amountDisplay}</span>
                </div>
                <div className="stepper">
                  <button
                    className="stepper-btn"
                    disabled={phase !== 'building' || n === 0}
                    onClick={() => setQty((q) => ({ ...q, [item.sku]: Math.max(0, n - 1) }))}
                    aria-label={`Remove one ${item.name}`}
                  >
                    −
                  </button>
                  <span className="stepper-value">{n}</span>
                  <button
                    className="stepper-btn"
                    disabled={phase !== 'building' || n >= 99}
                    onClick={() => setQty((q) => ({ ...q, [item.sku]: Math.min(99, n + 1) }))}
                    aria-label={`Add one ${item.name}`}
                  >
                    +
                  </button>
                </div>
              </li>
            )
          })}
        </ul>

        <div className="card-body stack" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="dl-total" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
            <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>Total</span>
            {/*
              Keyed on the value so React swaps the node on every change, which
              is what restarts the sweep. Re-rendering the same node would play
              it once and never again — and the whole point is to confirm the
              tap landed, at the moment it lands.
            */}
            <span key={totalPaise} className="amount-lg amount-sweep">
              {totalDisplay}
            </span>
          </div>

          {phase === 'active' ? (
            <button className="btn btn-secondary btn-block" onClick={reset}>
              Start a new order
            </button>
          ) : (
            <button
              className="btn btn-primary btn-lg btn-block"
              disabled={lines.length === 0 || phase === 'creating'}
              onClick={() => void createOrder()}
            >
              {phase === 'creating' && <span className="spinner" aria-hidden="true" />}
              {phase === 'creating'
                ? 'Creating…'
                : lines.length === 0
                  ? 'Add an item'
                  : `Create order — ${totalDisplay}`}
            </button>
          )}

          {error && (
            <div className="notice notice-danger">
              <span aria-hidden="true">!</span>
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------- QR + status -- */}
      <aside className="sticky-aside">
        <div className="card card-raised stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <span className="card-title">Customer scans this</span>

          {order ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="anim-qr"
                src={order.qrDataUrl}
                alt="Payment QR code"
                width={240}
                height={240}
                style={{
                  width: 240, height: 240, background: '#fff',
                  borderRadius: 'var(--r-md)', padding: 10,
                }}
              />
              <span className="anim-rise" style={{ animationDelay: '160ms' }}>
                <Countdown
                  expiresAt={expiresAt ?? Date.now() + order.expiresInSeconds * 1000}
                />
              </span>
              <div className="anim-rise" style={{ animationDelay: '220ms', width: '100%' }}>
                <OrderTile
                  orderId={order.orderId}
                  amountDisplay={order.amountDisplay}
                  initialStatus="claimed"
                />
              </div>
              <a
                href={order.qrUrl}
                target="_blank"
                rel="noreferrer"
                className="tiny mono gold"
                style={{ wordBreak: 'break-all' }}
              >
                {order.qrUrl}
              </a>
              <p className="tiny faint">
                Phone test: load this terminal on a LAN or tunnel URL the phone can
                reach — a localhost QR is not scannable from another device.
              </p>
            </>
          ) : (
            <div className="empty anim-rise">
              <p className="small">Build an order to generate a QR code.</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

/**
 * Counts down to an absolute deadline rather than from a duration measured at
 * mount. That is what lets the timer stay honest across a reload — after a
 * refresh the order has less time left than it started with, and a
 * mount-relative timer would cheerfully restart at the full fifteen minutes.
 */
function Countdown({ expiresAt }: { expiresAt: number }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((expiresAt - Date.now()) / 1000)))

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [expiresAt])

  const mm = String(Math.floor(left / 60)).padStart(2, '0')
  const ss = String(left % 60).padStart(2, '0')

  return left === 0 ? (
    <span className="badge badge-danger">Expired — start a new order</span>
  ) : (
    <span className="tiny mono muted">Expires in {mm}:{ss}</span>
  )
}

/**
 * Has this order reached a state no further payment can change?
 *
 * Leans on /api/orders/[id]/status, which staff may poll for their own store's
 * orders. `settled` there deliberately excludes 'abandoned' — the reconciler
 * gives up on those but a late authorisation can still land, so an abandoned
 * order stays restorable.
 *
 * A network failure answers false, i.e. "treat it as live". Wrongly keeping a
 * finished order costs one press of "Start a new order"; wrongly discarding a
 * live one blanks the QR under a customer mid-scan.
 */
async function hasSettled(orderId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/orders/${orderId}/status`, { cache: 'no-store' })
    if (!res.ok) return false
    const data = (await res.json()) as { settled?: boolean }
    return data.settled === true
  } catch {
    return false
  }
}

function formatInr(paise: number): string {
  const rupees = Math.floor(paise / 100)
  const frac = String(paise % 100).padStart(2, '0')
  const s = String(rupees)
  const grouped =
    s.length <= 3 ? s : `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`
  return `₹${grouped}.${frac}`
}
