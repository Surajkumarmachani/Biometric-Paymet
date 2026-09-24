import postgres from 'postgres'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Real Postgres for the correctness gates.
 *
 * No pg-mem, no mocks. The invariants under test — atomic challenge
 * consumption, the paid-is-never-demoted rule, exactly-once fulfilment, RLS
 * denial — are all properties of Postgres semantics. Testing them against a
 * fake would test the fake.
 *
 * Each suite gets its own freshly-migrated database so files run in parallel.
 */

const ADMIN_URL =
  process.env.TEST_PG_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:5433/postgres'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

export interface TestDb {
  sql: ReturnType<typeof postgres>
  url: string
  name: string
  drop: () => Promise<void>
  /** Run a callback as the `authenticated` role with a Clerk subject claim. */
  asAuthenticated: <T>(
    clerkSub: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ) => Promise<T>
  /** Run a callback as the `anon` role. */
  asAnon: <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => Promise<T>
}

export async function createTestDb(suite: string): Promise<TestDb> {
  const name = `regal_t_${suite.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${process.pid}`
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })

  try {
    await admin.unsafe(`drop database if exists ${name}`)
    await admin.unsafe(`create database ${name}`)
  } finally {
    await admin.end({ timeout: 5 })
  }

  const url = ADMIN_URL.replace(/\/postgres$/, `/${name}`)
  const sql = postgres(url, { max: 4, onnotice: () => {} })

  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith('.sql')) continue
    await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }

  const asRole = async <T>(
    role: 'authenticated' | 'anon',
    clerkSub: string | null,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> =>
    sql.begin(async (tx) => {
      // Mirrors what PostgREST does per request: set the role and the JWT
      // claims as a transaction-local GUC, which auth.jwt() then reads.
      await tx.unsafe(`set local role ${role}`)
      await tx.unsafe(
        `set local request.jwt.claims = '${JSON.stringify({ sub: clerkSub, role }).replace(/'/g, "''")}'`,
      )
      return fn(tx)
    }) as Promise<T>

  return {
    sql,
    url,
    name,
    drop: async () => {
      await sql.end({ timeout: 5 })
      const a = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
      try {
        await a.unsafe(`drop database if exists ${name} with (force)`)
      } finally {
        await a.end({ timeout: 5 })
      }
    },
    asAuthenticated: (clerkSub, fn) => asRole('authenticated', clerkSub, fn),
    asAnon: (fn) => asRole('anon', null, fn),
  }
}

/**
 * Assert that a client role is denied access — by EITHER a table-level
 * permission error or an empty result set.
 *
 * Both are genuine denials, and which one you get depends on whether a GRANT
 * exists. A table with RLS on and no policy but WITH a grant returns zero rows;
 * a table with no grant at all raises `permission denied`. The permission error
 * is the stronger outcome, so accepting only "zero rows" would wrongly fail.
 */
export async function expectDenied(
  run: () => Promise<unknown>,
): Promise<'permission_denied' | 'no_rows'> {
  try {
    const rows = (await run()) as Array<{ n?: number }>
    const n = rows[0]?.n ?? (Array.isArray(rows) ? rows.length : 0)
    if (n !== 0) {
      throw new Error(`expected denial but ${n} row(s)/count were visible`)
    }
    return 'no_rows'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/permission denied/i.test(message)) return 'permission_denied'
    throw err
  }
}

/**
 * Normalise a paise value for assertions.
 *
 * The same amount arrives in two different JS types depending on the path:
 *   * inside a jsonb result (jsonb_build_object) it is a JSON NUMBER
 *   * read as a bigint COLUMN, postgres.js hands back a STRING to avoid
 *     silent precision loss
 *
 * src/lib/money.ts `toPaise()` accepts both, which is why production code is
 * unaffected. Tests use this so an assertion never accidentally depends on
 * which path the value took.
 */
export function paise(v: unknown): number {
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error(`not integer paise: ${JSON.stringify(v)}`)
  return n
}

/** Read the single jsonb value returned by an `app.*` function. */
export function one<T>(rows: unknown): T {
  const arr = rows as Array<Record<string, unknown>>
  const first = arr[0]
  if (!first) throw new Error('no rows returned')
  return Object.values(first)[0] as T
}

export const ALICE = 'user_customer_alice'
export const BOB = 'user_customer_bob'
export const PRIYA = 'user_staff_priya'
export const STORE = '11111111-1111-1111-1111-111111111111'

let counter = 0
export function idem(prefix = 'k'): string {
  counter += 1
  return `${prefix}-${process.pid}-${counter}-${Date.now() % 100000}`.slice(0, 40)
}
