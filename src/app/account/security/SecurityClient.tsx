'use client'

import { useCallback, useEffect, useState } from 'react'
import { useUser, useReverification } from '@clerk/nextjs'

/**
 * Client half of the security centre. Four panels:
 *   1. This device — WebAuthn capability probe (drives the device matrix)
 *   2. Passkeys — Clerk-managed enrol / rename / delete (both behind step-up)
 *   3. Code fallback — the rate-limited OTP path for devices without a passkey
 *   4. Recent security events — the customer's own audit trail
 */

export interface SecurityEvent {
  event: string
  outcome: string
  at: string
}

interface PasskeyView {
  id: string
  name: string | null
  createdAt: Date
  lastUsedAt: Date | null
}

export default function SecurityClient({
  primaryEmail,
  events,
}: {
  primaryEmail: string
  events: SecurityEvent[]
}) {
  return (
    <div className="split">
      <div className="stack-6">
        <PasskeyPanel />
        <OtpPanel primaryEmail={primaryEmail} />
      </div>
      <aside className="stack-6">
        <DevicePanel />
        <EventsPanel events={events} />
      </aside>
    </div>
  )
}

/* ------------------------------------------------------------------ device -- */

interface Capability {
  supported: boolean
  platformAuthenticator: boolean | null
  conditionalMediation: boolean | null
}

function DevicePanel() {
  const [cap, setCap] = useState<Capability | null>(null)

  useEffect(() => {
    let cancelled = false
    async function probe() {
      const supported =
        typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined'
      if (!supported) {
        if (!cancelled) {
          setCap({ supported: false, platformAuthenticator: null, conditionalMediation: null })
        }
        return
      }
      const PK = window.PublicKeyCredential as unknown as {
        isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>
        isConditionalMediationAvailable?: () => Promise<boolean>
      }
      const platformAuthenticator = PK.isUserVerifyingPlatformAuthenticatorAvailable
        ? await PK.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false)
        : false
      const conditionalMediation = PK.isConditionalMediationAvailable
        ? await PK.isConditionalMediationAvailable().catch(() => false)
        : false
      if (!cancelled) setCap({ supported: true, platformAuthenticator, conditionalMediation })
    }
    void probe()
    return () => { cancelled = true }
  }, [])

  return (
    <section className="card card-raised stack">
      <span className="card-title">This device</span>
      {cap === null ? (
        <p className="small faint">Checking…</p>
      ) : (
        <ul className="stack-2">
          <Capline label="Passkeys supported" ok={cap.supported} />
          <Capline label="Built-in biometrics" ok={cap.platformAuthenticator} />
          <Capline label="Autofill sign-in" ok={cap.conditionalMediation} />
        </ul>
      )}
      {cap && !cap.platformAuthenticator && (
        <div className="notice notice-warn">
          <span aria-hidden="true">!</span>
          <span>
            No built-in biometric here. You can still add a passkey using a phone or
            a security key, or use the code fallback.
          </span>
        </div>
      )}
    </section>
  )
}

function Capline({ label, ok }: { label: string; ok: boolean | null }) {
  const cls = ok === null ? 'check-idk' : ok ? 'check-yes' : 'check-no'
  const mark = ok === null ? '–' : ok ? '✓' : '✕'
  return (
    <li className="check">
      <span className={`check-icon ${cls}`} aria-hidden="true">{mark}</span>
      <span>{label}</span>
    </li>
  )
}

/* ----------------------------------------------------------------- passkeys -- */

function PasskeyPanel() {
  const { isLoaded, user } = useUser()
  const [passkeys, setPasskeys] = useState<PasskeyView[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const sync = useCallback(() => {
    if (!user) return
    const list = (user.passkeys ?? []) as unknown as PasskeyView[]
    setPasskeys(
      list.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt,
      })),
    )
  }, [user])

  useEffect(() => { if (isLoaded) sync() }, [isLoaded, sync])

  // Enrolling and deleting a credential are both sensitive — Clerk requires a
  // fresh step-up, so wrap them and let useReverification pop the prompt.
  const enrollPasskey = useReverification(
    (u: { createPasskey: () => Promise<unknown> }) => u.createPasskey(),
  )
  const deletePasskey = useReverification((pk: { delete: () => Promise<unknown> }) => pk.delete())

  async function addPasskey() {
    if (!user) return
    setBusy(true); setError('')
    try {
      await enrollPasskey(user)
      await user.reload()
      sync()
    } catch (err) {
      setError(friendlyClerkError(err))
    } finally {
      setBusy(false)
    }
  }

  async function rename(id: string) {
    if (!user) return
    const current = user.passkeys?.find((p) => p.id === id)
    if (!current) return
    const name = window.prompt('Name this passkey', current.name ?? 'My passkey')
    if (name === null) return
    setBusy(true); setError('')
    try {
      await current.update({ name })
      await user.reload()
      sync()
    } catch (err) {
      setError(friendlyClerkError(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!user) return
    const current = user.passkeys?.find((p) => p.id === id)
    if (!current) return
    if (!window.confirm('Remove this passkey? You’ll need another way to sign in.')) return
    setBusy(true); setError('')
    try {
      await deletePasskey(current)
      await user.reload()
      sync()
    } catch (err) {
      setError(friendlyClerkError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card card-flush card-raised">
      <div className="card-head">
        <span className="card-title">Passkeys</span>
        {passkeys.length > 0 && (
          <span className="card-title">{passkeys.length} registered</span>
        )}
      </div>

      <div className="card-body stack">
        {!isLoaded ? (
          <p className="small faint">Loading…</p>
        ) : (
          <>
            {passkeys.length === 0 ? (
              <p className="small muted">
                No passkeys yet. Add one for one-touch sign-in and payment step-up.
              </p>
            ) : (
              <ul className="stack-2">
                {passkeys.map((pk) => (
                  <li
                    key={pk.id}
                    className="row-between"
                    style={{
                      padding: 'var(--s3) var(--s4)',
                      background: 'var(--surface-2)',
                      borderRadius: 'var(--r-md)',
                    }}
                  >
                    <div className="stack-2" style={{ gap: 2, minWidth: 0 }}>
                      <span className="h-card">{pk.name || 'Passkey'}</span>
                      <span className="tiny faint">
                        Added {pk.createdAt.toLocaleDateString('en-IN')}
                        {pk.lastUsedAt
                          ? ` · last used ${pk.lastUsedAt.toLocaleDateString('en-IN')}`
                          : ' · never used'}
                      </span>
                    </div>
                    <div className="row" style={{ gap: 'var(--s2)' }}>
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void rename(pk.id)}>
                        Rename
                      </button>
                      <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void remove(pk.id)}>
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div>
              <button className="btn btn-primary" disabled={busy} onClick={() => void addPasskey()}>
                {busy && <span className="spinner" aria-hidden="true" />}
                {busy ? 'Working…' : 'Add a passkey'}
              </button>
            </div>

            {error && (
              <div className="notice notice-danger">
                <span aria-hidden="true">!</span>
                <span>{error}</span>
              </div>
            )}

            <p className="tiny faint">
              Passkeys are per-device. Adding one on your phone doesn&rsquo;t create one
              on your laptop, and Apple and Google keep separate vaults.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------------- OTP -- */

function OtpPanel({ primaryEmail }: { primaryEmail: string }) {
  const [identifier, setIdentifier] = useState(primaryEmail)
  const [stage, setStage] = useState<'idle' | 'sent' | 'verified'>('idle')
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState('')
  const [tone, setTone] = useState<'info' | 'danger' | 'good'>('info')
  const [busy, setBusy] = useState(false)

  async function send() {
    setBusy(true); setMsg('')
    try {
      const res = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, purpose: 'verify' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setTone('danger')
        setMsg(data?.error?.message ?? 'Could not send a code.')
        return
      }
      setStage('sent')
      setTone('info')
      setMsg(
        data.delivered
          ? 'Code sent. It expires in 5 minutes.'
          : 'Dev mode: no provider configured — your code is printed in the server log.',
      )
    } catch {
      setTone('danger'); setMsg('Network error. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    setBusy(true); setMsg('')
    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, code, purpose: 'verify' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setTone('danger'); setMsg(data?.error?.message ?? 'Verification failed.')
        return
      }
      if (data.verified) {
        setStage('verified'); setTone('good'); setMsg('Verified.')
        return
      }
      setTone('danger')
      setMsg(
        data.reason === 'too_many_attempts'
          ? 'Too many attempts — request a new code.'
          : data.reason === 'no_active'
            ? 'No active code — request a new one.'
            : `Incorrect code${typeof data.remaining === 'number' ? ` — ${data.remaining} attempt(s) left.` : '.'}`,
      )
    } catch {
      setTone('danger'); setMsg('Network error. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card card-flush card-raised">
      <div className="card-head">
        <span className="card-title">Code fallback</span>
        <span className="card-title">OTP</span>
      </div>

      <div className="card-body stack">
        {stage === 'verified' ? (
          <div className="notice notice-good">
            <span aria-hidden="true">✓</span>
            <span>{identifier} verified.</span>
          </div>
        ) : (
          <>
            <p className="small muted">
              For devices without a passkey. Rate-limited from day one: per
              identifier, per IP, and a global ceiling.
            </p>

            <div className="field">
              <label className="label" htmlFor="otp-id">Email or phone</label>
              <input
                id="otp-id"
                className="input"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="you@example.com or +9198…"
                disabled={busy}
              />
            </div>

            {stage === 'sent' && (
              <div className="field">
                <label className="label" htmlFor="otp-code">6-digit code</label>
                <input
                  id="otp-code"
                  className="input input-mono"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  disabled={busy}
                />
              </div>
            )}

            <div className="row row-wrap">
              <button
                className="btn btn-secondary"
                disabled={busy || identifier.length < 3}
                onClick={() => void send()}
              >
                {stage === 'sent' ? 'Resend code' : 'Send code'}
              </button>
              {stage === 'sent' && (
                <button
                  className="btn btn-primary"
                  disabled={busy || code.length !== 6}
                  onClick={() => void verify()}
                >
                  Verify
                </button>
              )}
            </div>

            {msg && (
              <div className={`notice ${tone === 'danger' ? 'notice-danger' : tone === 'good' ? 'notice-good' : ''}`}>
                <span aria-hidden="true">{tone === 'danger' ? '!' : 'ℹ'}</span>
                <span>{msg}</span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------- events -- */

function EventsPanel({ events }: { events: SecurityEvent[] }) {
  return (
    <section className="card card-flush card-raised">
      <div className="card-head">
        <span className="card-title">Recent activity</span>
      </div>
      {events.length === 0 ? (
        <div className="empty"><p className="small">Nothing yet.</p></div>
      ) : (
        <ul style={{ padding: '0 var(--s5)' }}>
          {events.map((e, i) => (
            <li key={i} className="list-row" style={{ padding: 'var(--s3) 0' }}>
              <span className="small row" style={{ gap: 'var(--s2)', minWidth: 0 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 6, height: 6, borderRadius: '50%', flex: 'none',
                    background: e.outcome === 'success' ? 'var(--good)' : 'var(--danger)',
                  }}
                />
                {e.event.replace(/_/g, ' ')}
              </span>
              <span className="tiny faint" style={{ whiteSpace: 'nowrap' }}>{e.at}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function friendlyClerkError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/reverification_cancelled|cancelled/i.test(msg)) {
    return 'You cancelled the confirmation. Tap “Add a passkey” to try again — choose “Use another method” if it asks for a passkey you don’t have on this device yet.'
  }
  if (/passkey/i.test(msg) && /(not|disabled|enabled)/i.test(msg)) {
    return 'Passkeys are not enabled on this Clerk instance yet — enable them in the Clerk dashboard (User & Authentication → Passkeys).'
  }
  return msg || 'Something went wrong.'
}
