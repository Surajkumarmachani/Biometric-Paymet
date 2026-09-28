/**
 * Manage per-client API keys against the database in DATABASE_URL.
 *
 *   npm run keys -- create "Desktop till"              # default rate limit
 *   npm run keys -- create "Web frontend" --limit 3000 # per-minute override
 *   npm run keys -- list
 *   npm run keys -- revoke <key-id>
 *
 * The key is printed ONCE, at create. Only its sha256 is stored. In production
 * the database is not reachable from your laptop by default — use the admin
 * API (POST /api/admin/keys with X-Admin-Token) there instead.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateApiKey, hashApiKey, displayPrefix } from '../src/lib/api-key-format.ts'

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

const USAGE = `usage:
  npm run keys -- create "<name>" [--limit <per-minute>]
  npm run keys -- list
  npm run keys -- revoke <key-id>`

const [command, ...rest] = process.argv.slice(2)
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })

async function list(): Promise<void> {
  const rows = await sql`
    select id, name, key_prefix, active, rate_limit_per_min, created_at, last_used_at, request_count
      from api_keys order by created_at desc
  `
  if (rows.length === 0) {
    console.log('no API keys')
    return
  }
  for (const r of rows) {
    const state = r.active ? 'active ' : 'REVOKED'
    const limit = r.rate_limit_per_min ? `${r.rate_limit_per_min}/min` : 'default'
    const used = r.last_used_at ? new Date(r.last_used_at).toISOString().slice(0, 19) : 'never'
    console.log(
      `${r.id}  ${state}  ${String(r.key_prefix).padEnd(12)}  ${String(r.name).padEnd(24)}  ` +
        `${limit.padEnd(10)}  ${String(r.request_count).padStart(7)} req  last ${used}`,
    )
  }
}

try {
  if (command === 'create') {
    const limitAt = rest.indexOf('--limit')
    const limit = limitAt === -1 ? null : Number(rest[limitAt + 1])
    const name = rest.filter((_, i) => limitAt === -1 || (i !== limitAt && i !== limitAt + 1)).join(' ').trim()
    if (!name) throw new Error(USAGE)
    if (limit !== null && !(Number.isInteger(limit) && limit > 0)) throw new Error('--limit must be a positive integer')

    const key = generateApiKey()
    const [row] = await sql`
      insert into api_keys (name, key_hash, key_prefix, rate_limit_per_min)
      values (${name}, ${hashApiKey(key)}, ${displayPrefix(key)}, ${limit})
      returning id
    `
    console.log(`created "${name}"  id ${row!.id}`)
    console.log('')
    console.log(`  ${key}`)
    console.log('')
    console.log('Store this key now. It is not saved anywhere and cannot be shown again.')
  } else if (command === 'list') {
    await list()
  } else if (command === 'revoke') {
    const id = rest[0]
    if (!id) throw new Error(USAGE)
    const rows = await sql`
      update api_keys set active = false, revoked_at = coalesce(revoked_at, now())
       where id::text = ${id}
      returning name
    `
    if (rows.length === 0) throw new Error(`no key with id ${id}`)
    console.log(`revoked "${rows[0]!.name}"`)
  } else {
    throw new Error(USAGE)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
