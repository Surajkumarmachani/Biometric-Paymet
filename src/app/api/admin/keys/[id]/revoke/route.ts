import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin, revokeApiKey } from '@/lib/api-keys'
import { errorResponse, newRequestId, fail } from '@/lib/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Revoke. Takes effect on the key's very next request — there is no cache. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const requestId = newRequestId()
  try {
    await requireAdmin(request)

    const { id } = await context.params
    if (!z.string().uuid().safeParse(id).success) fail('invalid_request', 'bad key id')

    const row = await revokeApiKey(id)
    if (!row) fail('not_found', 'no such key')
    return NextResponse.json({ ...row, requestId })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
