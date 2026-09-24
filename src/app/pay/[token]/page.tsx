import { peekOrderByClaimToken } from '@/lib/orders'
import { formatINR } from '@/lib/money'
import { decideRails } from '@/lib/rails'
import PayClient from './PayClient'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The QR landing page.
 *
 * READ-ONLY. Loading this URL mutates nothing:
 *   * at this point there is no authenticated user, so there is nobody to bind
 *     the order to
 *   * a GET must not change state — and if it did, the customer's first page
 *     refresh would dead-end on "already claimed"
 *
 * Claiming happens later, from PayClient, via an authenticated POST to
 * /api/pay/claim which is idempotent for the same user.
 */
export default async function PayPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const order = await peekOrderByClaimToken(token)

  if (!order) {
    return (
      <Dead
        title="This code isn’t valid"
        body="Please ask our associate for a new one. If you scanned this from somewhere other than an in-store screen, don’t use it."
      />
    )
  }

  if (order.expired) {
    return (
      <Dead
        title="This code has expired"
        body="Ask our associate to show a fresh code. Codes are short-lived on purpose."
      />
    )
  }

  if (!order.claimable) {
    return (
      <Dead
        title="This order has moved on"
        body={`It’s already ${order.status.replace(/_/g, ' ')}. Please check with our associate.`}
      />
    )
  }

  const rails = decideRails(order.amountPaise)
  const lines = Array.isArray(order.lineItems)
    ? (order.lineItems as Array<{ name: string; qty: number; line_paise: number }>)
    : []

  return (
    <div className="page-tight">
      <div className="container container-sm stack-6">
        {/* The amount is rendered server-side from the order row, never from a
            client value — see the architecture doc on the residual XSS risk. */}
        <header className="stack-2 center stagger">
          <p className="eyebrow">REGAL LAB</p>
          <p className="amount-xl gold" style={{ margin: 0 }}>
            {formatINR(order.amountPaise)}
          </p>
          <p className="small muted">Amount due</p>
        </header>

        {lines.length > 0 && (
          <section className="card card-flush anim-rise" style={{ animationDelay: '160ms' }}>
            <div className="card-head">
              <span className="card-title">Your items</span>
              <span className="card-title">{lines.length}</span>
            </div>
            <ul className="stagger" style={{ padding: '0 var(--s5)' }}>
              {lines.map((l, i) => (
                <li key={i} className="list-row" style={{ padding: 'var(--s3) 0' }}>
                  <span className="small">
                    {l.name}
                    {l.qty > 1 && <span className="faint"> × {l.qty}</span>}
                  </span>
                  <span className="amount small">{formatINR(Number(l.line_paise))}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {rails.blocked.length > 0 && (
          <div className="notice notice-warn">
            <span aria-hidden="true">!</span>
            <span>{rails.blocked[0]!.reason} We&rsquo;ll use card or bank transfer instead.</span>
          </div>
        )}

        <div className="anim-lift" style={{ animationDelay: '260ms' }}>
          <PayClient
            token={token}
            orderId={order.orderId}
            amountDisplay={formatINR(order.amountPaise)}
          />
        </div>
      </div>
    </div>
  )
}

function Dead({ title, body }: { title: string; body: string }) {
  return (
    <div className="page">
      <div className="container container-sm stack center stagger">
        <p className="eyebrow">REGAL LAB</p>
        <h1 className="display h-page">{title}</h1>
        <p className="lede" style={{ margin: '0 auto' }}>{body}</p>
      </div>
    </div>
  )
}
