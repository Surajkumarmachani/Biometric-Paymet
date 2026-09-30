import 'server-only'
import { clerkClient } from '@clerk/nextjs/server'
import { sql, rpc } from './db'
import { fail } from './errors'
import { ensureAppUser } from './orders'

/**
 * Staff access management for admins (/staff/team, POST /api/staff/team).
 *
 * Every rule — admin-only, never your own access, never zero admins, audit —
 * is enforced in app.admin_set_staff (0020). This module only finds people and
 * reads the lists the page shows.
 */

export type StaffRole = 'associate' | 'manager' | 'admin'

export interface TeamMember {
  clerkId: string
  email: string | null
  role: StaffRole
  storeId: string
  storeName: string
  active: boolean
}

export interface StoreOption {
  id: string
  name: string
}

export async function listTeam(): Promise<TeamMember[]> {
  const rows = (await sql`
    select s.clerk_id, u.email, s.role, s.store_id, st.name as store_name, s.active
      from staff s
      join stores st on st.id = s.store_id
      left join app_users u on u.clerk_id = s.clerk_id
     order by s.active desc,
              case s.role when 'admin' then 0 when 'manager' then 1 else 2 end,
              u.email nulls last
  `) as unknown as Array<{
    clerk_id: string
    email: string | null
    role: StaffRole
    store_id: string
    store_name: string
    active: boolean
  }>
  return rows.map((r) => ({
    clerkId: r.clerk_id,
    email: r.email,
    role: r.role,
    storeId: r.store_id,
    storeName: r.store_name,
    active: r.active,
  }))
}

export async function listStores(): Promise<StoreOption[]> {
  return (await sql`
    select id, name from stores where active order by name
  `) as unknown as StoreOption[]
}

/**
 * The Clerk user for an email address, recorded in app_users.
 *
 * app_users only gets a row when someone places or claims an order, so a new
 * hire who has just signed up is usually not there yet. Clerk is the source of
 * truth for who exists; we look them up there and record them, which is the
 * same thing ensureAppUser does at checkout.
 */
export async function findUserByEmail(rawEmail: string): Promise<{ clerkId: string; email: string }> {
  const email = rawEmail.trim().toLowerCase()

  const known = (await sql`
    select clerk_id, email from app_users where lower(email) = ${email} limit 2
  `) as unknown as Array<{ clerk_id: string; email: string }>
  if (known.length === 1) return { clerkId: known[0]!.clerk_id, email: known[0]!.email }

  const client = await clerkClient()
  const { data } = await client.users.getUserList({ emailAddress: [email], limit: 2 })
  if (data.length === 0) {
    fail('not_found', 'no account with that email: ask them to sign up on the site first')
  }
  if (data.length > 1) fail('conflict', 'more than one account uses that email')

  const user = data[0]!
  await ensureAppUser(user.id, email)
  return { clerkId: user.id, email }
}

export async function setStaffAccess(args: {
  actorId: string
  targetId: string
  storeId: string
  role: StaffRole
  active: boolean
}): Promise<{ clerkId: string; role: StaffRole; storeId: string; active: boolean; created: boolean }> {
  const out = await rpc<{ clerk_id: string; role: StaffRole; store_id: string; active: boolean; created: boolean }>(sql`
    select app.admin_set_staff(
      ${args.actorId},
      ${args.targetId},
      ${args.storeId}::uuid,
      ${args.role}::staff_role,
      ${args.active}
    )
  `)
  return {
    clerkId: out.clerk_id,
    role: out.role,
    storeId: out.store_id,
    active: out.active,
    created: out.created,
  }
}

/**
 * Plain-language reasons for the refusals admin_set_staff and findUserByEmail
 * raise on purpose. errorResponse() deliberately returns only generic
 * messages, but an admin needs to know WHY a change was refused ("you can't
 * change your own access"). Only these texts, all written by us, are passed
 * through; anything else stays generic.
 */
const TEAM_REFUSALS: Array<[RegExp, string]> = [
  [/only an active admin can change staff access/, 'Only an active admin can change staff access.'],
  [/you cannot change your own access/, 'You can’t change your own access. Ask another admin.'],
  [/unknown user: they must sign in/, 'That person hasn’t signed in to the site yet. Ask them to sign in once, then try again.'],
  [/no account with that email/, 'No account uses that email. Ask them to sign up on the site first.'],
  [/more than one account uses that email/, 'More than one account uses that email.'],
  [/unknown or inactive store/, 'That store doesn’t exist or is inactive.'],
  [/there must always be at least one active admin/, 'There must always be at least one active admin.'],
]

export function teamRefusal(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err)
  for (const [re, text] of TEAM_REFUSALS) if (re.test(msg)) return text
  return null
}
