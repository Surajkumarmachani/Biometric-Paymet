import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin, createApiKey, listApiKeys } from '@/lib/api-keys'
import { errorResponse, newRequestId, fail } from '@/lib/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Key management over HTTP, for production where the CLI cannot reach the
 * database. Guarded by X-Admin-Token (see requireAdmin), not by an API key.
 */
const Body = z.object({
  name: z.string().trim().min(1).max(100),
  rateLimitPerMin: z.number().int().min(1).max(100_000).optional(),
})

/** Create. The response is the ONLY time the key is ever shown. */
export async function POST(request: Request) {
  const requestId = newRequestId()
  try {
    await requireAdmin(request)

    const parsed = Body.safeParse(await request.json().catch(() => null))
    if (!parsed.success) fail('invalid_request', parsed.error.message)

    const { key, row } = await createApiKey(parsed.data.name, parsed.data.rateLimitPerMin)
    return NextResponse.json(
      {
        key,
        warning: 'Store this key now. It is not saved anywhere and cannot be shown again.',
        ...row,
        requestId,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return errorResponse(err, requestId)
  }
}

export async function GET(request: Request) {
  const requestId = newRequestId()
  try {
    await requireAdmin(request)
    return NextResponse.json({ keys: await listApiKeys(), requestId })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
