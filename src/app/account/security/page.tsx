import { auth, currentUser } from '@clerk/nextjs/server'
import { SignInButton } from '@clerk/nextjs'
import { sql } from '@/lib/db'
import SecurityClient, { type SecurityEvent } from './SecurityClient'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Identity & security centre.
 *
 * Passkey enrolment and credential management (Clerk-managed), a device
 * capability probe, and the OTP fallback — plus the customer's own recent
 * security events.
 */
export default async function SecurityPage() {
  const { userId } = await auth()

  if (!userId) {
    return (
      <div className="page">
        <div className="container container-sm stack">
          <p className="eyebrow">Security</p>
          <h1 className="display h-page">Sign in to manage your security</h1>
          <p className="lede">Passkeys, devices, and sign-in methods.</p>
          <div>
            <SignInButton mode="modal">
              <button className="btn btn-primary btn-lg">Sign in</button>
            </SignInButton>
          </div>
        </div>
      </div>
    )
  }

  const user = await currentUser()
  const primaryEmail = user?.primaryEmailAddress?.emailAddress ?? ''

  // Server-side (service role) read of this user's own audit trail. The
  // my_security_events view filters by auth.jwt()->>'sub', which is null under
  // the service role, so we filter by userId here instead.
  const rows = (await sql`
    select event, outcome, created_at
      from auth_audit_log
     where user_id = ${userId}
     order by created_at desc
     limit 10
  `) as unknown as Array<{ event: string; outcome: string; created_at: string }>

  // Format once, server-side, with a fixed locale + timezone. Formatting on the
  // client with toLocaleString() would mismatch the server render and trip a
  // React hydration error.
  const events: SecurityEvent[] = rows.map((r) => ({
    event: r.event,
    outcome: r.outcome,
    at: new Date(r.created_at).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
  }))

  return (
    <div className="page-tight">
      <div className="container">
        <div className="stack-2" style={{ marginBottom: 'var(--s6)' }}>
          <p className="eyebrow">Security</p>
          <h1 className="display h-page">Passkeys &amp; sign-in</h1>
          <p className="small muted">
            Manage how you confirm payments, check what this device supports, and
            use the code fallback.
          </p>
        </div>

        <SecurityClient primaryEmail={primaryEmail} events={events} />
      </div>
    </div>
  )
}
