import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { enforce } from '@/lib/rate-limit'
import { sql, rpc } from '@/lib/db'
import { audit } from '@/lib/audit'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { readJson } from '@/lib/body'
import { toPaise, formatINR } from '@/lib/money'
import { requireApiKey } from '@/lib/api-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The customer asks for a refund. This moves NO money.
 *
 * Deliberately not a self-service refund. Every actual refund in this app goes
 * through /api/orders/[id]/refund, which requires the manager role, a fresh
 * passkey step-up and alerts on every call — a customer-triggered refund would
 * bypass all three, and on a store whose orders run to six figures that is not
 * a trade anyone would take. So this records the ask; a manager answers it.
 *
 * No step-up here for the same reason: there is nothing to protect. The worst a
 * stolen session can do is ask for the account owner's own money back, to the
 * original payment method, and put a row in front of staff.
 *
 * POST   open a request
 * DELETE withdraw the open one
 */
const Body = z.object({
  /** Omit for everything still refundable. */
  amountPaise: z.number().int().positive().optional(),
  reason: z.string().min(1).max(200),
})

/** The outcome object app.request_refund returns — see 0013. */
interface RequestResult {
  ok: boolean
  reason?: string
  status?: string
  refundable_paise?: number
  request_id?: string
  amount_paise?: number
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    const session = await requireUser()
    await enforce('refundRequestPerUser', session.userId)

    const { id } = await context.params
    if (!z.string().uuid().safeParse(id).success) fail('invalid_request', 'bad order id')

    const parsed = Body.safeParse(await readJson(request))
    if (!parsed.success) fail('invalid_request', parsed.error.message)

    const out = await rpc<RequestResult>(sql`
      select app.request_refund(
        ${id}::uuid,
        ${session.userId},
        ${parsed.data.reason},
        ${parsed.data.amountPaise ?? null}
      )
    `)

    if (!out.ok) {
      /*
       * `not_found` and `not_yours` collapse to the same 404 on purpose: which
       * one it was tells an attacker whether an order id exists, and the order
       * page already keeps that distinction hidden for the same reason.
       */
      switch (out.reason) {
        case 'not_found':
        case 'not_yours':
          fail('not_found', `refund request rejected: ${out.reason}`)
        case 'not_refundable':
          fail('conflict', `order is ${out.status}, not paid`)
        case 'nothing_left':
          fail('conflict', 'this payment has already been fully refunded')
        case 'amount_out_of_range':
          fail('invalid_request', 'amount exceeds what is still refundable')
        case 'already_open':
          fail('conflict', 'a refund request is already open on this order')
        default:
          fail('internal', `unexpected request_refund reason: ${out.reason}`)
      }
    }

    await audit({
      event: 'refund_requested',
      outcome: 'success',
      userId: session.userId,
      orderId: id,
      detail: {
        requestId: out.request_id,
        amountPaise: out.amount_paise,
        reason: parsed.data.reason,
      },
    })

    const amountPaise = toPaise(out.amount_paise ?? 0)
    return NextResponse.json({
      orderId: id,
      refundRequestId: out.request_id,
      status: 'pending',
      amountPaise,
      amountDisplay: formatINR(amountPaise),
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    const session = await requireUser()
    await enforce('refundRequestPerUser', session.userId)

    const { id } = await context.params
    if (!z.string().uuid().safeParse(id).success) fail('invalid_request', 'bad order id')

    // Scoped to the requester inside the function, so this cannot withdraw
    // somebody else's request even with a valid order id.
    const out = await rpc<{ ok: boolean; reason?: string; request_id?: string }>(sql`
      select app.withdraw_refund_request(${id}::uuid, ${session.userId})
    `)

    if (!out.ok) fail('conflict', 'no open refund request on this order')

    await audit({
      event: 'refund_request_withdrawn',
      outcome: 'success',
      userId: session.userId,
      orderId: id,
      detail: { requestId: out.request_id },
    })

    return NextResponse.json({ orderId: id, status: 'withdrawn', requestId })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
