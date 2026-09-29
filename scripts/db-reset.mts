/**
 * Apply every migration to DATABASE_URL, in order.
 *
 * Skips 0000_local_supabase_shim.sql unless --with-shim is passed: Supabase
 * already provides the auth schema, auth.jwt() and the anon/authenticated/
 * service_role roles, and recreating them there would be wrong.
 *
 * Skips 0003_seed_dev.sql unless --with-seed is passed. It creates ₹1 and ₹5
 * "Test Item" products, a fake store and a fake manager — fine on a laptop,
 * a live ₹1 checkout and a stranger's staff row in production. The go-live
 * checklist runs this script against prod, so the safe default is "no seed".
 *
 *   npm run db:reset                               # production: no shim, no seed
 *   npm run db:reset -- --with-shim --with-seed    # a vanilla local Postgres
 */
import postgres from 'postgres'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const withShim = process.argv.includes('--with-shim')
const withSeed = process.argv.includes('--with-seed')
const dir = join(process.cwd(), 'supabase', 'migrations')
const sql = postgres(url, { max: 1, onnotice: () => {} })

try {
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue
    if (file.includes('local_supabase_shim') && !withShim) {
      console.log(`skip  ${file}  (Supabase provides this; pass --with-shim for local PG)`)
      continue
    }
    if (file.includes('seed_dev') && !withSeed) {
      console.log(`skip  ${file}  (dev fixtures; pass --with-seed for a local database)`)
      continue
    }
    process.stdout.write(`apply ${file} ... `)
    await sql.unsafe(readFileSync(join(dir, file), 'utf8'))
    console.log('ok')
  }

  // Realtime on orders is what lets the store terminal learn the outcome of a
  // QR handover. Without it the associate is left guessing.
  await sql.unsafe(`
    do $$
    begin
      if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        begin
          alter publication supabase_realtime add table orders;
        exception when duplicate_object then null;
        end;
      end if;
    end $$;
  `)
  console.log('realtime: orders added to supabase_realtime (if present)')
  console.log('\ndone')
} finally {
  await sql.end({ timeout: 5 })
}
