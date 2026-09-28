import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth'
import { sql, rpc } from '@/lib/db'
import { audit } from '@/lib/audit'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { requireApiKey } from '@/lib/api-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Decline a customer's refund request.
 *
 * Decline is the only decision that ends here. There is no matching "approve"
 * endpoint by design: approving a request means actually refunding it, which
 * goes through /api/orders/[id]/refund with its manager role, fresh step-up and
 * alert — and that route closes the request on success. An approve endpoint
 * here could only flip a status without money moving, which is precisely the
 * lie the customer would then be shown.
 *
 * Manager, matching who can refund: an associate who could decline would hold
 * half the decision without holding the other half.
 *
 * No step-up: declining moves no money and is reversible — the customer can ask
 * again. The refund itself keeps its step-up.
 */
const Body = z.object({
  /** Shown to the customer, so keep it a sentence they can act on. */
  note: z.string().max(200).optional(),
})

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    const staff = await requireStaff('manager')

    const { id } = await context.params
    if (!z.string().uuid().safeParse(id).success) fail('invalid_request', 'bad request id')

    const parsed = Body.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) fail('invalid_request', parsed.error.message)

    const out = await rpc<{ ok: boolean; reason?: string; order_id?: string }>(sql`
      select app.decline_refund_request(
        ${id}::uuid,
        ${staff.userId},
        ${parsed.data.note ?? null}
      )
    `)

    // Only an open request can be declined; anything else has already been
    // answered (or withdrawn) and the staff view is simply stale.
    if (!out.ok) fail('conflict', 'that refund request is no longer open')

    await audit({
      event: 'refund_request_declined',
      outcome: 'success',
      userId: staff.userId,
      orderId: out.order_id ?? null,
      detail: { refundRequestId: id, note: parsed.data.note ?? null },
    })

    return NextResponse.json({
      refundRequestId: id,
      orderId: out.order_id,
      status: 'declined',
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
