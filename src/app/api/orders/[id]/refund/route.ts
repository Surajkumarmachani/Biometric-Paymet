import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth, reverificationError } from '@clerk/nextjs/server'
import { requireStaff, REVERIFY_CONFIG, reverificationIdFromClaims } from '@/lib/auth'
import { enforce } from '@/lib/rate-limit'
import { sql, rpc } from '@/lib/db'
import { refundPayment } from '@/lib/razorpay/api'
import { issueCreditNote } from '@/lib/credit-note'
import { audit, alertOn } from '@/lib/audit'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { toPaise } from '@/lib/money'
import { requireApiKey } from '@/lib/api-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Refunds move money outward, so: manager role, a fresh step-up, a tight rate
 * limit, and an alert on every one.
 *
 * Idempotency comes from refunds.razorpay_refund_id being UNIQUE — a repeated
 * webhook or a double-click cannot double-refund, and app.apply_refund
 * recomputes the total from the refunds table rather than incrementing.
 */
const Body = z.object({
  /** Omit for a full refund. */
  amountPaise: z.number().int().positive().optional(),
  reason: z.string().min(1).max(200),
})

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    // Role first: a non-staff caller gets a flat 403 rather than a pointless
    // reverification prompt.
    const staff = await requireStaff('manager')

    // Refunds always require a fresh gesture. Return the Clerk reverification
    // HINT (not a plain 403) so the client's useReverification hook pops the
    // step-up and retries — a bare 403 would just surface as an error.
    const a = await auth()
    if (!a.has({ reverification: REVERIFY_CONFIG })) {
      return NextResponse.json(reverificationError(REVERIFY_CONFIG), { status: 403 })
    }
    const reverificationId = reverificationIdFromClaims(a.sessionClaims)
    if (!reverificationId) {
      fail(
        'forbidden',
        'reverification_id claim missing — add {"reverification_id":"{{session.reverification_id}}"} to the Clerk session token',
      )
    }

    await enforce('refundPerStaff', staff.userId)

    const { id } = await context.params
    if (!z.string().uuid().safeParse(id).success) fail('invalid_request', 'bad order id')

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) fail('invalid_request', parsed.error.message)

    // One step-up buys one refund. Clerk keeps a reverification valid for its
    // whole window, so a spent one gets a fresh prompt, not an error.
    if (await refundGestureUsed(reverificationId)) {
      return NextResponse.json(reverificationError(REVERIFY_CONFIG), { status: 403 })
    }

    /*
     * Admission, the Razorpay call and the bookkeeping share ONE transaction.
     *
     * app.reserve_refund locks the order row, requires `paid` (a charged_back
     * or disputed order must not be refunded on top of the bank's clawback),
     * spends the step-up, and reports what is still refundable. The lock is
     * held across the Razorpay call, so a second manager refunding the same
     * order waits and then sees the first refund in its ceiling, instead of
     * both passing the same stale number.
     *
     * The ceiling counts pending + processed refunds, not just the settled
     * ones: orders.amount_refunded_paise is processed-only by design, and
     * using it here would let a second full refund through while the first is
     * still pending.
     */
    const { refund, out, requested } = await sql.begin(async (tx) => {
      const reserved = await rpc<{
        razorpay_payment_id: string
        remaining_paise: string
      }>(tx`select app.reserve_refund(${id}::uuid, ${reverificationId}, ${staff.userId})`)

      const remaining = toPaise(reserved.remaining_paise)
      const requested = parsed.data.amountPaise ?? remaining

      if (remaining <= 0) fail('conflict', 'this payment is already fully refunded or a refund is pending')
      if (requested <= 0) fail('conflict', 'nothing left to refund')
      if (requested > remaining) {
        fail('invalid_request', 'refund exceeds the remaining refundable amount')
      }

      const refund = await refundPayment({
        paymentId: reserved.razorpay_payment_id,
        amountPaise: requested,
        notes: { order_id: id, reason: parsed.data.reason, staff_id: staff.userId },
      })

      // Record immediately; the refund.processed webhook will converge on the
      // final status via the same function. If anything after the Razorpay
      // call throws, that webhook still records the refund.
      const out = await rpc<{ amount_refunded_paise: string; fully_refunded: boolean }>(tx`
        select app.apply_refund(
          ${reserved.razorpay_payment_id},
          ${refund.id},
          ${toPaise(refund.amount)},
          ${refund.status}
        )
      `)
      return { refund, out, requested }
    })

    // Issue the GST credit note here too, not only on the refund.processed
    // webhook: a refund must not depend on webhook delivery to become a legal
    // document. app.issue_credit_note is idempotent on the refund id, so
    // whichever path lands first wins and the other is a no-op.
    if (refund.status === 'processed') {
      try {
        const cn = await issueCreditNote({
          orderId: id,
          ref: refund.id,
          reason: 'refund',
          amountPaise: toPaise(refund.amount),
        })
        if (cn) {
          await audit({
            event: 'credit_note_issued',
            outcome: 'success',
            userId: staff.userId,
            orderId: id,
            detail: { creditNoteNo: cn.credit_note_no, reason: 'refund' },
          })
        }
      } catch (err) {
        // A missing credit note must never fail a refund the customer is owed.
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'credit_note_failed',
            orderId: id,
            detail: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    }

    /*
     * The customer asked, and this is the answer — close any open request on
     * this order so their order page stops saying "awaiting review" while the
     * money is already on its way back.
     *
     * After the refund, never before, and inside its own try: a refund that has
     * already been accepted by Razorpay must not fail because a bookkeeping
     * update did. It creates nothing when no request exists, so a staff-initiated
     * refund at the counter stays exactly that.
     */
    try {
      const closed = await rpc<number>(sql`
        select app.approve_open_refund_requests(${id}::uuid, ${staff.userId})
      `)
      if (Number(closed) > 0) {
        await audit({
          event: 'refund_request_approved',
          outcome: 'success',
          userId: staff.userId,
          orderId: id,
          detail: { closed: Number(closed), refundId: refund.id },
        })
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'refund_request_close_failed',
          orderId: id,
          refundId: refund.id,
          detail: err instanceof Error ? err.message : String(err),
        }),
      )
    }

    alertOn('refund_initiated', {
      orderId: id,
      refundId: refund.id,
      amountPaise: requested,
      staffId: staff.userId,
    })
    await audit({
      event: 'refund_initiated',
      outcome: 'success',
      userId: staff.userId,
      orderId: id,
      detail: { refundId: refund.id, amountPaise: requested, reason: parsed.data.reason },
    })

    return NextResponse.json({
      orderId: id,
      refundId: refund.id,
      // Razorpay's own state for this refund. 'pending' means accepted but the
      // money has not moved yet, so amountRefundedPaise stays 0 until the
      // refund.processed webhook converges it — the UI must say so rather than
      // claim a ₹0 refund happened.
      refundStatus: refund.status,
      requestedPaise: requested,
      amountRefundedPaise: toPaise(out.amount_refunded_paise),
      fullyRefunded: out.fully_refunded,
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}

async function refundGestureUsed(reverificationId: string): Promise<boolean> {
  const rows = (await sql`
    select 1 from refund_gestures where reverification_id = ${reverificationId} limit 1
  `) as unknown as unknown[]
  return rows.length > 0
}
