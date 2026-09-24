import 'server-only'
import postgres from 'postgres'
import { databaseUrl } from '@/env'

/**
 * Server-side database access.
 *
 * We talk to Postgres directly rather than through PostgREST because every
 * write in this app is a service-role operation invoking one of the `app.*`
 * functions, and because two of those functions rely on properties PostgREST
 * cannot express:
 *
 *   * app.create_payment_challenge does INSERT..SELECT so the amount is read
 *     from `orders` rather than accepted from a caller
 *   * app.consume_payment_challenge is a single atomic UPDATE..RETURNING
 *
 * Client-side reads go through supabase-js with the anon key and are governed
 * by RLS (see 0001_schema.sql).
 *
 * Note: `bigint` columns are returned as JS strings by postgres.js to avoid
 * silent precision loss. Always route them through `toPaise()` in money.ts —
 * never `Number()` them at a call site.
 */

declare global {
  // eslint-disable-next-line no-var
  var __regalSql: ReturnType<typeof postgres> | undefined
}

function create() {
  return postgres(databaseUrl(), {
    // Serverless: keep the pool tiny and let Supabase's pooler do the work.
    max: Number(process.env.PG_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // required when connecting through pgbouncer in transaction mode
    onnotice: () => {},
    types: {
      // Return bigint as string. 9007199254740991 paise is ~₹90 trillion, so
      // Number would technically survive, but making the boundary explicit
      // keeps money out of float arithmetic by construction.
      bigint: postgres.BigInt,
    },
  })
}

function instance(): ReturnType<typeof postgres> {
  // Reuse across hot reloads in dev and across warm invocations in prod.
  return global.__regalSql ?? (global.__regalSql = create())
}

/**
 * Lazily-connected client.
 *
 * Deliberately a proxy rather than `export const sql = create()`. Next.js
 * imports every route module during `next build` to analyse it, so eagerly
 * calling `create()` at module scope would demand DATABASE_URL at build time
 * and fail the build on any machine that only has runtime secrets. The
 * connection is opened on first actual use instead.
 */
export const sql: ReturnType<typeof postgres> = new Proxy(
  (() => {}) as unknown as ReturnType<typeof postgres>,
  {
    apply(_target, _thisArg, args: unknown[]) {
      return (instance() as unknown as (...a: unknown[]) => unknown)(...args)
    },
    get(_target, prop: string | symbol) {
      const client = instance() as unknown as Record<string | symbol, unknown>
      const value = client[prop]
      return typeof value === 'function' ? value.bind(client) : value
    },
  },
)

/**
 * Bind a value as a jsonb parameter. ALWAYS use this — never
 * `${JSON.stringify(x)}::jsonb`.
 *
 * postgres.js treats a JS string destined for a json/jsonb parameter as a JSON
 * *string* and quotes it, so `${JSON.stringify([{sku}])}::jsonb` stores
 * `"[{\"sku\":...}]"` — a jsonb of type `string`, not `array`. Every
 * `jsonb_typeof(...) = 'array'` guard then fails, and a jsonb payload silently
 * becomes an opaque blob. `sql.json()` with the real object is the fix.
 *
 * The cast exists because postgres.js's exported `JSONValue` type rejects both
 * `Record<string, unknown>` and arrays of interfaces, even though the runtime
 * handles them correctly.
 */
export function jsonb(value: unknown) {
  return sql.json(value as Parameters<typeof sql.json>[0])
}

/** Call one of the `app.*` functions and return its jsonb result. */
export async function rpc<T = unknown>(
  fnCall: ReturnType<typeof sql>,
): Promise<T> {
  const rows = (await fnCall) as unknown as Array<Record<string, unknown>>
  const first = rows[0]
  if (!first) throw new Error('rpc returned no rows')
  const values = Object.values(first)
  return values[0] as T
}

export async function closeDb(): Promise<void> {
  if (global.__regalSql) {
    await global.__regalSql.end({ timeout: 5 })
    global.__regalSql = undefined
  }
}
