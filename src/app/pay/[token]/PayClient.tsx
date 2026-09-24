'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Script from 'next/script'
import { useRouter } from 'next/navigation'
import { SignedIn, SignedOut, SignInButton, useReverification } from '@clerk/nextjs'
import { isReverificationHint } from '@/lib/reverification'
import SuccessTick from '@/components/SuccessTick'

/**
 * The customer-side payment flow.
 *
 * Sequence:
 *   1. sign in (Clerk) — a new customer signs up here
 *   2. POST /api/pay/claim      — idempotent, binds the order to this customer
 *   3. POST /api/pay/authorize  — Clerk passkey step-up, then Razorpay order
 *   4. Razorpay Standard Checkout — UPI intent on mobile, QR on desktop
 *   5. POST /api/pay/confirm    — advisory fast path
 *   6. poll /api/orders/:id/status — the safety net that actually matters
 *   7. hand off to /orders/:id — the itemised order, which is what someone
 *      actually wants to see once the money has moved
 *
 * The bit most implementations get wrong is step 6. When the customer taps UPI,
 * their app takes over and this browser context is gone — the checkout `handler`
 * never fires. That is NORMAL. So `modal.ondismiss` must move the UI to
 * "confirming payment…" and never to "failed".
 */

type Phase =
  | 'idle'
  | 'claiming'
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
  rails: { preferred: string; expectation: string }
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void }
  }
}

export default function PayClient({
  token,
  orderId,
  amountDisplay,
}: {
  token: string
  orderId: string
  amountDisplay: string
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string>('')
  const [receiptNo, setReceiptNo] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const router = useRouter()

  // Clerk drives the passkey/biometric prompt. useReverification wraps the call
  // so that a step-up requirement triggers the step-up UI and retries.
  const authorize = useReverification(async (): Promise<AuthorizeResponse> => {
    const res = await fetch('/api/pay/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId }),
    })
    const data = await res.json().catch(() => null)
    if (res.ok) return data as AuthorizeResponse
    // Return the hint (not throw) so useReverification pops the step-up + retries.
    if (isReverificationHint(data)) return data as unknown as AuthorizeResponse
    throw new Error(data?.error?.message ?? 'authorize failed')
  })

  const poll = useCallback(
    async (attempt = 0) => {
      try {
        const res = await fetch(`/api/orders/${orderId}/status`, { cache: 'no-store' })
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
        // keep polling; a transient network error is not a payment failure
      }

      // ~15 minutes of polling, matching Razorpay's documented 3–15 minute
      // transaction timeout. The cron reconciler covers everything after that.
      if (attempt > 90) {
        setMessage(
          'Still confirming with your bank. We’ll email you the moment it settles — you can close this page.',
        )
        return
      }
      const delay = attempt < 6 ? 2000 : attempt < 20 ? 5000 : 10000
      pollTimer.current = setTimeout(() => void poll(attempt + 1), delay)
    },
    [orderId],
  )

  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current) }, [])

  /**
   * Warm the order route while the customer is still paying.
   *
   * The hand-off below is immediate, so whatever it costs to render
   * /orders/[id] is time the customer spends staring at this screen instead of
   * their receipt. Prefetching during the Razorpay sheet — dead time either
   * way — turns that into a near-instant swap.
   */
  useEffect(() => {
    if (phase === 'checkout' || phase === 'confirming') {
      router.prefetch(`/orders/${orderId}`)
    }
  }, [phase, orderId, router])

  /**
   * The moment the money has moved, go to the itemised order.
   *
   * No delay and no button. Two success screens in a row is one more than the
   * flow needs: /orders/[id] already opens with the tick, the amount and the
   * receipt, and it adds the line items — the "paid for what" that a bare PAID
   * card cannot answer. It is also a durable URL, which this page is not; the
   * claim token is single-use and short-lived.
   *
   * `replace`, not `push`, so Back doesn't return to a spent claim token —
   * that page would only say "this order has moved on".
   */
  useEffect(() => {
    if (phase !== 'paid') return
    router.replace(`/orders/${orderId}`)
  }, [phase, orderId, router])

  async function start() {
    setMessage('')
    try {
      setPhase('claiming')
      const claim = await fetch('/api/pay/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (!claim.ok) {
        const body = await claim.json()
        setPhase('failed')
        setMessage(body?.error?.message ?? 'This order is with another customer.')
        return
      }

      setPhase('authorizing')
      const auth = await authorize()

      setPhase('checkout')
      openCheckout(auth)
    } catch (err) {
      setPhase('failed')
      const msg = err instanceof Error ? err.message : 'Something went wrong.'
      setMessage(
        /cancel/i.test(msg)
          ? 'You cancelled the confirmation. Tap to try again.'
          : msg,
      )
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
      // Amount and order are Razorpay's own — we pass order_id and Razorpay
      // reads the amount from the order it holds. Nothing here can change it.
      order_id: auth.razorpayOrderId,
      currency: auth.currency,
      name: 'REGAL LAB',
      description: amountDisplay,
      // Helps in-app browsers that don't support iframes (Instagram, Messenger,
      // UC Browser) — all common in India.
      callback_url: `${window.location.origin}/pay/${token}`,
      redirect: false,
      handler: async (response: {
        razorpay_order_id: string
        razorpay_payment_id: string
        razorpay_signature: string
      }) => {
        setPhase('confirming')
        try {
          const res = await fetch('/api/pay/confirm', {
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
        void poll()
      },
      modal: {
        // THE important one. The customer switching to their UPI app looks
        // exactly like a dismissal. Never treat this as a failure.
        ondismiss: () => {
          setPhase('confirming')
          void poll()
        },
        escape: false,
        backdropclose: false,
      },
      theme: { color: '#c8a04a' },
    })

    rzp.open()
  }

  const busy = phase === 'claiming' || phase === 'authorizing' || phase === 'checkout'

  return (
    <>
      <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="afterInteractive" />

      <SignedOut>
        <div className="stack">
          <SignInButton mode="modal">
            <button className="btn btn-primary btn-lg btn-block">Continue</button>
          </SignInButton>
          <p className="tiny faint center">
            You&rsquo;ll set up a passkey once. After that, paying is a single touch.
          </p>
        </div>
      </SignedOut>

      <SignedIn>
        {phase === 'paid' ? (
          <div className="card stack center anim-pop" style={{ alignItems: 'center', background: 'var(--good-bg)', borderColor: 'var(--good-line)' }}>
            <SuccessTick size={64} />
            <span className="badge badge-good badge-tick">PAID</span>
            <p className="amount-lg" style={{ margin: 0 }}>{amountDisplay}</p>
            {receiptNo && <p className="tiny mono muted">Receipt {receiptNo}</p>}
            <p className="small muted">Opening your order&hellip;</p>
            {/*
              A quiet fallback, not a call to action. The redirect above fires
              on the same tick, so this is only ever on screen while the order
              page renders — but if navigation fails outright (blocked history
              API, a route that won't load) the customer must not be stranded
              on a screen with no way forward. Deliberately a text link rather
              than a button: nothing here should invite a tap that races the
              redirect.
            */}
            <Link href={`/orders/${orderId}`} className="tiny faint">
              Tap here if this doesn&rsquo;t open on its own
            </Link>
          </div>
        ) : phase === 'confirming' ? (
          <div className="card stack center anim-rise" style={{ alignItems: 'center' }}>
            <span className="spinner" aria-hidden="true" />
            <p className="h-section is-waiting" style={{ margin: 0 }}>Confirming your payment…</p>
            <p className="small muted">
              {message || 'Finish in your payment app if it’s still open. Don’t close this page.'}
            </p>
          </div>
        ) : (
          <div className="stack">
            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={() => void start()}
              disabled={busy}
            >
              {busy && <span className="spinner" aria-hidden="true" />}
              {phase === 'idle' && `Pay ${amountDisplay}`}
              {phase === 'claiming' && 'Opening your order…'}
              {phase === 'authorizing' && 'Confirm with your fingerprint or face…'}
              {phase === 'checkout' && 'Choose how to pay…'}
              {phase === 'failed' && `Try again — ${amountDisplay}`}
            </button>

            {message ? (
              <div className="notice notice-danger">
                <span aria-hidden="true">!</span>
                <span>{message}</span>
              </div>
            ) : (
              <p className="tiny faint center">
                Your bank or UPI app performs the final confirmation — often a
                fingerprint, sometimes a PIN or OTP.
              </p>
            )}
          </div>
        )}
      </SignedIn>
    </>
  )
}
