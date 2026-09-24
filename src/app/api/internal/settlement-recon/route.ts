import { NextResponse } from 'next/server'
import { assertInternalSecret } from '@/lib/auth'
import { reconcileSettlements } from '@/lib/settlement'
import { errorResponse, newRequestId } from '@/lib/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Settlement reconciliation (S5). Schedule daily, after Razorpay's settlement
 * cycle. Reconciles the current month by default; pass ?year=&month=&day= to
 * target a specific period (e.g. backfill). Secret-guarded like the other
 * internal jobs.
 */
async function run(request: Request) {
  const requestId = newRequestId()
  try {
    assertInternalSecret(
      request.headers.get('x-internal-secret') ??
        request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
        null,
    )
    const url = new URL(request.url)
    const now = new Date()
    const year = Number(url.searchParams.get('year')) || now.getUTCFullYear()
    const month = Number(url.searchParams.get('month')) || now.getUTCMonth() + 1
    const dayParam = url.searchParams.get('day')
    const day = dayParam ? Number(dayParam) : undefined

    const report = await reconcileSettlements({ year, month, day })
    return NextResponse.json({ ...report, period: { year, month, day: day ?? null }, requestId })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}

export const GET = run
export const POST = run
