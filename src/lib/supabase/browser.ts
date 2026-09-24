'use client'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Anon-key client, for client-side reads and Realtime only.
 *
 * Every read through this client is governed by the RLS policies in
 * 0001_schema.sql, which compare auth.jwt()->>'sub' against the Clerk subject.
 * Writes never go through here — they go through server routes using the
 * service-role key, which bypasses RLS and never leaves the server.
 *
 * For the RLS policies to see a Clerk subject you must wire Clerk as a
 * third-party auth provider in Supabase and pass the Clerk session token via
 * `accessToken`.
 */

let client: SupabaseClient | null = null

/**
 * Whether a Supabase project is configured at all.
 *
 * Realtime is an accelerator, not the truth: OrderTile also polls
 * /api/orders/[id]/status every 5s and that is what actually guarantees the
 * associate learns the outcome. So a deployment can legitimately run with no
 * Supabase project (e.g. a local-Postgres dev box) — callers check this and
 * skip the subscription rather than throwing inside an effect, which would
 * take the whole tile down and lose the poll as well.
 */
export function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
}

export function supabaseBrowser(getToken: () => Promise<string | null>): SupabaseClient {
  if (client) return client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Supabase public env not configured')

  client = createClient(url, key, {
    auth: { persistSession: false },
    accessToken: async () => (await getToken()) ?? '',
  })
  return client
}
