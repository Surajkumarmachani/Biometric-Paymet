import { auth } from '@clerk/nextjs/server'
import { SignInButton } from '@clerk/nextjs'
import { requireStaff } from '@/lib/auth'
import { sql } from '@/lib/db'
import { toPaise, formatINR } from '@/lib/money'
import TerminalClient, { type CatalogItem } from './TerminalClient'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * In-store terminal.
 *
 * An associate builds an order, we mint a single-use claim token and show its QR.
 * The customer scans it on their own phone, signs in, claims, does the passkey
 * step-up, and pays — and the tile here flips to PAID over Supabase Realtime.
 * Staff-only.
 */
export default async function TerminalPage() {
  const { userId } = await auth()

  if (!userId) {
    return (
      <div className="page">
        <div className="container container-sm stack">
          <p className="eyebrow">Store terminal</p>
          <h1 className="display h-page">Staff sign-in required</h1>
          <div>
            <SignInButton mode="modal">
              <button className="btn btn-primary btn-lg">Sign in</button>
            </SignInButton>
          </div>
        </div>
      </div>
    )
  }

  // Staff gate. requireStaff throws 'forbidden' for a non-staff user; catch it
  // and show a plain message rather than a 500.
  let store: { storeId: string; role: string }
  try {
    const s = await requireStaff('associate')
    store = { storeId: s.storeId, role: s.role }
  } catch {
    return (
      <div className="page">
        <div className="container container-sm stack">
          <p className="eyebrow">Store terminal</p>
          <h1 className="display h-page">This account isn&rsquo;t staff</h1>
          <div className="notice notice-warn">
            <span aria-hidden="true">!</span>
            <span>
              Ask an admin to add you to a store, or sign in with a staff account.
            </span>
          </div>
        </div>
      </div>
    )
  }

  const storeRows = (await sql`
    select name from stores where id = ${store.storeId}::uuid limit 1
  `) as unknown as Array<{ name: string }>
  const storeName = storeRows[0]?.name ?? 'Store'

  const rows = (await sql`
    select p.sku, p.name, pp.amount_paise
      from products p
      join product_prices pp on pp.product_id = p.id and pp.valid_to is null
     where p.active
     order by pp.amount_paise
  `) as unknown as Array<{ sku: string; name: string; amount_paise: string }>

  const catalog: CatalogItem[] = rows.map((r) => {
    const amountPaise = toPaise(r.amount_paise)
    return { sku: r.sku, name: r.name, amountPaise, amountDisplay: formatINR(amountPaise) }
  })

  return (
    <div className="page-tight">
      <div className="container">
        <div className="row-between row-wrap" style={{ marginBottom: 'var(--s6)' }}>
          <div className="stack-2">
            <p className="eyebrow">Store terminal</p>
            <h1 className="display h-page">Take a payment</h1>
            <p className="small muted">
              Build the order, show the QR, hand the phone back to the customer.
            </p>
          </div>
          <div className="row">
            <span className="badge badge-gold">{store.role}</span>
            <span className="small muted">{storeName}</span>
          </div>
        </div>

        <TerminalClient catalog={catalog} />
      </div>
    </div>
  )
}
