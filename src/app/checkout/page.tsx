import { auth } from '@clerk/nextjs/server'
import { SignInButton } from '@clerk/nextjs'
import { sql } from '@/lib/db'
import { toPaise, formatINR } from '@/lib/money'
import { maxOrderPaise } from '@/lib/risk'
import CheckoutClient, { type CatalogItem } from './CheckoutClient'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Customer self-checkout.
 *
 * The client sends only {sku, qty}; app.create_order prices every line from
 * product_prices, so this page cannot influence the amount.
 */
export default async function CheckoutPage() {
  const { userId } = await auth()

  if (!userId) {
    return (
      <div className="page">
        <div className="container container-sm stack">
          <p className="eyebrow">Checkout</p>
          <h1 className="display h-page">Sign in to continue</h1>
          <p className="lede">
            You&rsquo;ll set up a passkey once. After that, paying is a single touch.
          </p>
          <div>
            <SignInButton mode="modal">
              <button className="btn btn-primary btn-lg">Sign in</button>
            </SignInButton>
          </div>
        </div>
      </div>
    )
  }

  // Active products with a current price. Display only — the authoritative price
  // is re-read server-side at order time.
  const rows = (await sql`
    select p.sku, p.name, pp.amount_paise, pp.currency
      from products p
      join product_prices pp on pp.product_id = p.id and pp.valid_to is null
     where p.active
     order by pp.amount_paise
  `) as unknown as Array<{
    sku: string
    name: string
    amount_paise: string
    currency: string
  }>

  const cap = maxOrderPaise()

  const catalog: CatalogItem[] = rows.map((r) => {
    const amountPaise = toPaise(r.amount_paise)
    return {
      sku: r.sku,
      name: r.name,
      amountPaise,
      amountDisplay: formatINR(amountPaise),
      currency: r.currency,
      overCap: amountPaise > cap,
    }
  })

  return (
    <div className="page-tight">
      <div className="container">
        <div className="stack-2" style={{ marginBottom: 'var(--s6)' }}>
          <p className="eyebrow">Checkout</p>
          <h1 className="display h-page">Choose what you&rsquo;re buying</h1>
          <p className="small muted">
            Prices are calculated on our server — this page never sends an amount.
          </p>
        </div>

        <CheckoutClient catalog={catalog} capDisplay={formatINR(cap)} />
      </div>
    </div>
  )
}
