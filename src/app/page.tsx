import Link from 'next/link'
import { SignUpButton, SignedIn, SignedOut } from '@clerk/nextjs'
import { currentUser } from '@clerk/nextjs/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const user = await currentUser()
  const firstName = user?.firstName ?? null
  const email = user?.primaryEmailAddress?.emailAddress ?? null

  return (
    <div className="page">
      <div className="container">
        {/* ---------------------------------------------------------- hero -- */}
        <section className="stack" style={{ gap: 'var(--s5)', maxWidth: '54ch' }}>
          <p className="eyebrow">Touchless checkout · India</p>
          {/* No forced break — text-wrap: balance evens the lines at any width. */}
          <h1 className="display h-hero" style={{ maxWidth: '22ch' }}>
            Pay in one touch. No forms, no card numbers.
          </h1>
          <p className="lede">
            Confirm with your fingerprint or face. Your bank still does the final
            approval — we just remove everything else.
          </p>

          <SignedOut>
            <div className="row row-wrap" style={{ gap: 'var(--s3)' }}>
              <SignUpButton mode="modal">
                <button className="btn btn-primary btn-lg">Create an account</button>
              </SignUpButton>
              <span className="small faint">Takes about a minute.</span>
            </div>
          </SignedOut>

          <SignedIn>
            <div className="row row-wrap" style={{ gap: 'var(--s3)' }}>
              <Link href="/checkout" className="btn btn-primary btn-lg">
                Start a checkout
              </Link>
              <Link href="/orders" className="btn btn-secondary btn-lg">
                View orders
              </Link>
            </div>
            <p className="small faint">
              Signed in{firstName ? ` as ${firstName}` : ''}
              {email ? ` · ${email}` : ''}
            </p>
          </SignedIn>
        </section>

        <hr className="rule" style={{ margin: 'var(--s7) 0' }} />

        {/* --------------------------------------------------- how it works -- */}
        <section className="split">
          <div className="stack-6">
            <div className="stack-2">
              <h2 className="h-section">How paying works</h2>
              <p className="small muted">
                Four steps. The only thing you do is the gesture.
              </p>
            </div>

            <ol className="steps">
              <li className="step">
                <div>
                  <div className="step-title">Pick your items</div>
                  <p className="step-body">
                    In store, an associate shows you a QR code. Online, you build a
                    basket. Either way the price is calculated on our server — the
                    page can never send an amount.
                  </p>
                </div>
              </li>
              <li className="step">
                <div>
                  <div className="step-title">Confirm with your body</div>
                  <p className="step-body">
                    Fingerprint, face, or your device PIN. This authorises the exact
                    amount for that one order, and it can only be used once.
                  </p>
                </div>
              </li>
              <li className="step">
                <div>
                  <div className="step-title">Your bank approves it</div>
                  <p className="step-body">
                    UPI, card, or netbanking. Your bank or UPI app performs the final
                    check — sometimes a fingerprint, sometimes a PIN or OTP.
                  </p>
                </div>
              </li>
              <li className="step">
                <div>
                  <div className="step-title">Receipt, immediately</div>
                  <p className="step-body">
                    You get a receipt number and a GST tax invoice. If your payment
                    app takes over and comes back later, we still catch it.
                  </p>
                </div>
              </li>
            </ol>
          </div>

          {/* ------------------------------------------------------- aside -- */}
          <aside className="stack">
            <div className="card card-raised">
              <p className="card-title" style={{ marginBottom: 'var(--s4)' }}>
                What protects you
              </p>
              <ul className="stack-2">
                <li className="check">
                  <span className="check-icon check-yes">✓</span>
                  <span className="small">
                    <strong>No card details here.</strong> Payment happens inside
                    Razorpay&rsquo;s checkout, never on our page.
                  </span>
                </li>
                <li className="check">
                  <span className="check-icon check-yes">✓</span>
                  <span className="small">
                    <strong>One gesture, one payment.</strong> A confirmation
                    can&rsquo;t be reused for a second charge.
                  </span>
                </li>
                <li className="check">
                  <span className="check-icon check-yes">✓</span>
                  <span className="small">
                    <strong>The amount is ours to set.</strong> Prices come from our
                    own tables, so a tampered page can&rsquo;t change what you pay.
                  </span>
                </li>
                <li className="check">
                  <span className="check-icon check-yes">✓</span>
                  <span className="small">
                    <strong>Nothing gets lost.</strong> If a payment lands late, a
                    reconciler finds it and fulfils your order.
                  </span>
                </li>
              </ul>
            </div>

            <div className="notice notice-info">
              <span aria-hidden="true">ℹ</span>
              <span>
                Your passkey proves who you are to us. It does not replace your
                bank&rsquo;s own authentication.
              </span>
            </div>
          </aside>
        </section>
      </div>
    </div>
  )
}
