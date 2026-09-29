import 'server-only'
import { auth } from '@clerk/nextjs/server'
import { sql } from './db'
import { fail } from './errors'

/**
 * Clerk is the identity layer. Two things to know:
 *
 * 1. Clerk subjects are STRINGS ('user_2ab...'), not uuids. Every user_id column
 *    is `text` and RLS compares against auth.jwt()->>'sub'. Using Supabase's
 *    auth.uid() here raises 22P02 because it casts `sub` to uuid.
 *
 * 2. Clerk owns the WebAuthn ceremony. It mints the challenge and rp.id, and
 *    your backend never sees authenticatorData / signature / clientDataJSON.
 *    So Clerk passkeys cannot give cryptographic transaction binding. What they
 *    DO give is `reverification_id` (fresh and unique per step-up) and `fva`
 *    (factor verification age). We store the reverification_id against the
 *    order under a UNIQUE constraint — that constraint is the single-use
 *    guarantee for Option A.
 *
 * To make `reverification_id` readable here you must add it as a custom session
 * token claim in the Clerk dashboard:
 *     { "reverification_id": "{{session.reverification_id}}" }
 */

export interface Session {
  userId: string
  reverificationId: string | null
  /** [firstFactorAgeMinutes, secondFactorAgeMinutes] */
  fva: [number, number] | null
}

export async function requireUser(): Promise<Session> {
  const a = await auth()
  if (!a.userId) fail('unauthenticated')

  const claims = a.sessionClaims as Record<string, unknown> | null
  const rid = typeof claims?.reverification_id === 'string' ? claims.reverification_id : null
  const fvaRaw = claims?.fva
  const fva =
    Array.isArray(fvaRaw) && fvaRaw.length === 2
      ? ([Number(fvaRaw[0]), Number(fvaRaw[1])] as [number, number])
      : null

  return { userId: a.userId, reverificationId: rid, fva }
}

/**
 * The step-up requirement for a payment.
 *
 * `afterMinutes: 1` is deliberate: "the customer verified within the last
 * minute", which for a checkout is effectively "just now, for this payment". Do
 * NOT relax it to reuse an older verification — threat 19 requires fresh user
 * verification on every payment, and there is no zero-gesture path.
 */
export const REVERIFY_CONFIG = { level: 'first_factor', afterMinutes: 1 } as const

/** Pull the single-use reverification_id out of the session claims, or null. */
export function reverificationIdFromClaims(claims: unknown): string | null {
  const c = claims as Record<string, unknown> | null
  const rid = c?.reverification_id
  return typeof rid === 'string' && rid.length > 0 ? rid : null
}

/**
 * Require a fresh step-up for this action, in a NON-HTTP context.
 *
 * Fails closed. HTTP routes should NOT use this — they must instead return the
 * Clerk reverification *hint* (reverificationError) so the client's
 * useReverification hook can pop the step-up UI and retry. See
 * /api/pay/authorize. Kept for completeness / server-only callers.
 */
export async function requireStepUp(): Promise<{ userId: string; reverificationId: string }> {
  const a = await auth()
  if (!a.userId) fail('unauthenticated')

  const ok = a.has({ reverification: REVERIFY_CONFIG })
  if (!ok) fail('forbidden', 'reverification required')

  const rid = reverificationIdFromClaims(a.sessionClaims)
  if (!rid) {
    // Without this claim we cannot bind the step-up to the order, so we cannot
    // guarantee single use. Refuse rather than degrade.
    fail(
      'forbidden',
      'reverification_id claim missing — add {"reverification_id":"{{session.reverification_id}}"} to the Clerk session token',
    )
  }
  return { userId: a.userId, reverificationId: rid }
}

export interface StaffSession extends Session {
  storeId: string
  role: 'associate' | 'manager' | 'admin'
}

/**
 * Non-throwing staff lookup, for UI that merely wants to know whether to show a
 * staff link. Never use this to guard an action — requireStaff() is the gate.
 */
export async function staffRole(
  userId: string | null | undefined,
): Promise<StaffSession['role'] | null> {
  if (!userId) return null
  const rows = (await sql`
    select role from staff where clerk_id = ${userId} and active limit 1
  `) as unknown as Array<{ role: StaffSession['role'] }>
  return rows[0]?.role ?? null
}

/**
 * May this staff member see an order they did not place?
 *
 * One rule, used everywhere an order is shown to staff: associates see their
 * own store's orders, managers and admins see any store's. Before this was
 * shared, the order page let ANY staff role open ANY order, and the order
 * search let associates query across every store.
 */
export function staffMaySee(
  staff: { storeId: string; role: StaffSession['role'] } | null | undefined,
  orderStoreId: string | null | undefined,
): boolean {
  if (!staff) return false
  if (staff.role === 'manager' || staff.role === 'admin') return true
  return !!orderStoreId && staff.storeId === orderStoreId
}

/** Non-throwing staff lookup with store, for read-only visibility checks. */
export async function staffOf(
  userId: string | null | undefined,
): Promise<{ storeId: string; role: StaffSession['role'] } | null> {
  if (!userId) return null
  const rows = (await sql`
    select store_id, role from staff where clerk_id = ${userId} and active limit 1
  `) as unknown as Array<{ store_id: string; role: StaffSession['role'] }>
  const row = rows[0]
  return row ? { storeId: row.store_id, role: row.role } : null
}

export async function requireStaff(
  minRole: 'associate' | 'manager' | 'admin' = 'associate',
): Promise<StaffSession> {
  const session = await requireUser()

  const rows = (await sql`
    select store_id, role from staff
     where clerk_id = ${session.userId} and active
     limit 1
  `) as unknown as Array<{ store_id: string; role: StaffSession['role'] }>

  const row = rows[0]
  if (!row) fail('forbidden', 'not staff')

  const rank = { associate: 0, manager: 1, admin: 2 } as const
  if (rank[row.role] < rank[minRole]) fail('forbidden', `requires ${minRole}`)

  return { ...session, storeId: row.store_id, role: row.role }
}

/** Shortest ADMIN_TOKEN / INTERNAL_TASK_SECRET we will honour (= openssl rand -hex 16). */
export const MIN_SECRET_LENGTH = 32

/** Guards the cron-driven internal routes. Constant-time compare. */
export function assertInternalSecret(header: string | null): void {
  const expected = process.env.INTERNAL_TASK_SECRET
  if (!expected || !header) fail('forbidden', 'internal secret missing')
  // A short secret is guessable; treat it as no secret at all (fail closed)
  // rather than run the crons behind it. Generate with: openssl rand -hex 32
  if (expected.length < MIN_SECRET_LENGTH) fail('forbidden', 'INTERNAL_TASK_SECRET shorter than 32 chars')
  const a = Buffer.from(header, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) fail('forbidden', 'internal secret mismatch')
  // Node's timingSafeEqual via a dynamic import would be async here; lengths
  // already match so a constant-time XOR is enough.
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  if (diff !== 0) fail('forbidden', 'internal secret mismatch')
}
