import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import { SignInButton } from '@clerk/nextjs'
import { requireStaff } from '@/lib/auth'
import { listTeam, listStores } from '@/lib/team'
import TeamClient from './TeamClient'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Team: who has staff access, and at what role. Admins only.
 *
 * Presentation only — POST /api/staff/team and app.admin_set_staff (0020) are
 * the real gates. What each role can do:
 *   associate — run the terminal for their store
 *   manager   — plus refunds on their own store's orders
 *   admin     — refunds on any order, and manage this page
 */
export default async function TeamPage() {
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

  try {
    await requireStaff('admin')
  } catch {
    return (
      <Shell>
        <h1 className="display h-page">Admins only</h1>
        <div className="notice notice-warn">
          <span aria-hidden="true">!</span>
          <span>Only an admin can manage staff access. Ask an admin if you need a role changed.</span>
        </div>
      </Shell>
    )
  }

  const [team, stores] = await Promise.all([listTeam(), listStores()])

  return (
    <div className="page-tight">
      <div className="container">
        <div className="row-between row-wrap" style={{ marginBottom: 'var(--s6)' }}>
          <div className="stack-2">
            <p className="eyebrow">Staff</p>
            <h1 className="display h-page">Team &amp; access</h1>
            <p className="small muted">
              Associates run the terminal. Managers also refund their own store&rsquo;s orders.
              Admins refund anything and manage this page.
            </p>
          </div>
          <div className="row">
            <span className="badge badge-gold">admin</span>
            <Link href="/staff/orders" className="btn btn-secondary btn-sm">Refunds</Link>
          </div>
        </div>

        <TeamClient team={team} stores={stores} me={userId} />
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
