/**
 * Grant a Clerk user a staff row so /staff/terminal lets them in.
 *
 *   npm run staff -- suraj@example.com            # by email, role manager
 *   npm run staff -- user_3I29Cu... associate     # by Clerk id
 *   npm run staff -- --list                       # who is staff today
 *
 * Staff membership is the one thing the app cannot self-provision. App users
 * are created just-in-time on first sign-in (`ensureAppUser`), but staff is a
 * grant, not a fact about the visitor — so a freshly reset database has only
 * the seed's fictional associate and the terminal refuses everyone real. This
 * closes that gap without hand-written SQL.
 *
 * Resolves an email through the Clerk Backend API so you never have to go
 * hunting for a `user_...` id in the dashboard.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function envValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key]
  try {
    const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() !== key) continue
      return trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // no .env.local
  }
  return undefined
}

const databaseUrl = envValue('DATABASE_URL')
if (!databaseUrl) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const ROLES = ['associate', 'manager', 'admin'] as const
type Role = (typeof ROLES)[number]

const args = process.argv.slice(2)
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })

async function list(): Promise<void> {
  const rows = await sql`
    select s.clerk_id, s.role, s.active, u.email, st.name as store
      from staff s
      join stores st on st.id = s.store_id
      left join app_users u using (clerk_id)
     order by s.role, u.email nulls last
  `
  if (rows.length === 0) {
    console.log('no staff rows')
    return
  }
  for (const r of rows) {
    const flag = r.active ? '' : '  (INACTIVE)'
    console.log(`${String(r.role).padEnd(10)} ${String(r.email ?? '—').padEnd(32)} ${r.clerk_id}  @ ${r.store}${flag}`)
  }
}

/** Look up a Clerk user id from an email address via the Backend API. */
async function clerkIdForEmail(email: string): Promise<{ id: string; email: string }> {
  const secret = envValue('CLERK_SECRET_KEY')
  if (!secret) {
    throw new Error('CLERK_SECRET_KEY is not set, so an email cannot be resolved — pass the user_... id instead')
  }
  const url = `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}&limit=2`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } })
  if (!res.ok) throw new Error(`Clerk API ${res.status}: ${await res.text()}`)
  const users = (await res.json()) as Array<{
    id: string
    email_addresses?: Array<{ email_address: string }>
  }>
  if (users.length === 0) {
    throw new Error(`no Clerk user with email ${email} — they must sign in once first`)
  }
  return { id: users[0].id, email: users[0].email_addresses?.[0]?.email_address ?? email }
}

try {
  if (args.length === 0 || args.includes('--list')) {
    await list()
    process.exit(0)
  }

  const [identifier, roleArg] = args
  const role: Role = (roleArg as Role) ?? 'manager'
  if (!ROLES.includes(role)) {
    console.error(`role must be one of ${ROLES.join(', ')}`)
    process.exit(1)
  }

  const resolved = identifier.startsWith('user_')
    ? { id: identifier, email: null as string | null }
    : await clerkIdForEmail(identifier)

  // One store in the seed; if there are several, take the first active one.
  const [store] = await sql<{ id: string; name: string }[]>`
    select id, name from stores where active order by name limit 1
  `
  if (!store) throw new Error('no active store — run `npm run db:local:reset` first')

  await sql`
    insert into app_users (clerk_id, email)
    values (${resolved.id}, ${resolved.email})
    on conflict (clerk_id) do update
       set email = coalesce(excluded.email, app_users.email)
  `
  await sql`
    insert into staff (clerk_id, store_id, role, active)
    values (${resolved.id}, ${store.id}, ${role}, true)
    on conflict (clerk_id) do update
       set role = excluded.role, store_id = excluded.store_id, active = true
  `

  console.log(`${resolved.email ?? resolved.id} is now ${role} at ${store.name}`)
  console.log('')
  await list()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
