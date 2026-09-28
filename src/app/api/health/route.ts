import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Liveness for Cloud Run and uptime checks. Deliberately needs no API key and
 * touches no database — an unauthenticated route that hit Postgres would be a
 * free way to load it.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' })
}
