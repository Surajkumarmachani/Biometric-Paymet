'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useReverification } from '@clerk/nextjs'
import { isReverificationHint } from '@/lib/reverification'
import { apiFetch } from '@/lib/api-client'

/**
 * Team list + add form. Every save goes through POST /api/staff/team, which
 * demands a fresh passkey step-up: the route returns Clerk's reverification
 * hint, useReverification pops the prompt and retries. The server enforces
 * every rule; the disabled controls here (your own row) are only a courtesy.
 */

type Role = 'associate' | 'manager' | 'admin'

interface Member {
  clerkId: string
  email: string | null
  role: Role
  storeId: string
  storeName: string
  active: boolean
}

interface Store {
  id: string
  name: string
}

const ROLE_HELP: Record<Role, string> = {
  associate: 'Terminal only',
  manager: 'Terminal + refunds for their store',
  admin: 'Everything, incl. this page',
}

type Change = { email?: string; clerkId?: string; role: Role; storeId: string; active: boolean }

function useSaveAccess() {
  return useReverification(async (body: Change) => {
    const res = await apiFetch('/api/staff/team', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (res.ok) return data
    if (isReverificationHint(data)) return data
    throw new Error(data?.error?.message ?? 'Could not save that change.')
  })
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return /cancel/i.test(msg) ? 'You cancelled the confirmation. Nothing was changed.' : msg
}

export default function TeamClient({ team, stores, me }: { team: Member[]; stores: Store[]; me: string }) {
  return (
    <div className="stack-6">
      <AddStaff stores={stores} />

      <div className="card card-flush card-raised">
        <div className="card-head">
          <span className="card-title">Staff</span>
          <span className="card-title">{team.filter((m) => m.active).length} active</span>
        </div>
        {team.length === 0 ? (
          <div className="empty stack" style={{ alignItems: 'center' }}>
            <p className="small">No staff yet.</p>
          </div>
        ) : (
          <ul>
            {team.map((m) => (
              <MemberRow key={m.clerkId} member={m} stores={stores} isMe={m.clerkId === me} />
            ))}
          </ul>
        )}
      </div>

      <p className="tiny faint">
        Every change asks for your passkey and is recorded in the audit log. You can&rsquo;t change
        your own access, and there is always at least one active admin.
      </p>
    </div>
  )
}

function MemberRow({ member, stores, isMe }: { member: Member; stores: Store[]; isMe: boolean }) {
  const router = useRouter()
  const save = useSaveAccess()
  const [role, setRole] = useState<Role>(member.role)
  const [storeId, setStoreId] = useState(member.storeId)
  const [active, setActive] = useState(member.active)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const dirty = role !== member.role || storeId !== member.storeId || active !== member.active

  async function submit() {
    setBusy(true); setError(''); setSaved(false)
    try {
      const result = await save({ clerkId: member.clerkId, role, storeId, active })
      if (!result?.clerkId) {
        setError('Not saved — the confirmation was cancelled.')
        return
      }
      setSaved(true)
      router.refresh()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li style={{ borderBottom: '1px solid var(--border)', padding: 'var(--s4) var(--s5)' }}>
      <div className="row-between row-wrap" style={{ gap: 'var(--s4)', alignItems: 'flex-start' }}>
        <div className="stack-2" style={{ gap: 3, minWidth: 0 }}>
          <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
            <span style={{ fontWeight: 600 }}>{member.email ?? member.clerkId}</span>
            {isMe && <span className="badge badge-gold badge-plain">you</span>}
            {!member.active && <span className="badge badge-warn badge-plain">no access</span>}
          </div>
          <span className="tiny faint">
            {member.role} · {member.storeName} · {ROLE_HELP[member.role]}
          </span>
        </div>

        {isMe ? (
          <span className="tiny faint" style={{ maxWidth: 260 }}>
            You can&rsquo;t change your own access. Another admin can.
          </span>
        ) : (
          <div className="row row-wrap" style={{ gap: 'var(--s3)' }}>
            <select
              className="input"
              style={{ width: 'auto' }}
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              aria-label={`Role for ${member.email ?? member.clerkId}`}
            >
              <option value="associate">Associate</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
            {stores.length > 1 && (
              <select
                className="input"
                style={{ width: 'auto' }}
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                aria-label={`Store for ${member.email ?? member.clerkId}`}
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              Access
            </label>
            <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={submit}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="notice notice-danger" style={{ marginTop: 'var(--s3)' }}>
          <span aria-hidden="true">!</span>
          <span>{error}</span>
        </div>
      )}
      {saved && !dirty && (
        <p className="tiny" style={{ marginTop: 'var(--s2)', color: 'var(--good)' }}>Saved.</p>
      )}
    </li>
  )
}

function AddStaff({ stores }: { stores: Store[] }) {
  const router = useRouter()
  const save = useSaveAccess()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('associate')
  const [storeId, setStoreId] = useState(stores[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setDone('')
    try {
      const result = await save({ email: email.trim(), role, storeId, active: true })
      if (!result?.clerkId) {
        setError('Not saved — the confirmation was cancelled.')
        return
      }
      setDone(`${email.trim()} is now ${result.role}${result.created ? '' : ' (updated)'}.`)
      setEmail('')
      router.refresh()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card card-raised stack">
      <span className="card-title">Add staff</span>
      <p className="small muted">
        They must have signed up on the site once. Their role applies the next time they load a page.
      </p>
      <div className="row row-wrap" style={{ gap: 'var(--s3)', alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: '1 1 260px' }}>
          <label className="label" htmlFor="team-email">Email</label>
          <input
            id="team-email"
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="team-role">Role</label>
          <select id="team-role" className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="associate">Associate — terminal only</option>
            <option value="manager">Manager — + refunds for their store</option>
            <option value="admin">Admin — everything</option>
          </select>
        </div>
        {stores.length > 1 && (
          <div className="field">
            <label className="label" htmlFor="team-store">Store</label>
            <select id="team-store" className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !email.trim() || !storeId}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>

      {error && (
        <div className="notice notice-danger">
          <span aria-hidden="true">!</span>
          <span>{error}</span>
        </div>
      )}
      {done && (
        <div className="notice notice-good">
          <span aria-hidden="true">✓</span>
          <span>{done}</span>
        </div>
      )}
    </form>
  )
}
