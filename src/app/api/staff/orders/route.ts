import { NextResponse } from 'next/server'
import { z } from 'zod'
import QRCode from 'qrcode'
import { requireStaff } from '@/lib/auth'
import { enforce } from '@/lib/rate-limit'
import { createStoreOrder } from '@/lib/orders'
import { decideRails } from '@/lib/rails'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { readJson } from '@/lib/body'
import { formatINR } from '@/lib/money'
import { requireApiKey } from '@/lib/api-keys'
import { payOrigin } from '@/lib/pay-origin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * In-store entry point. Staff builds the order on the terminal; we return a QR
 * payload for the customer to scan with their own phone.
 *
 * The QR encodes a single-use claim token and nothing else. It does NOT encode
 * a session, and scanning it mutates nothing (see /pay/[token]).
 *
 * The plaintext token is returned exactly once, here. Only its sha256 is
 * stored, so a database read cannot reconstruct a live QR.
 */
const Body = z.object({
  lines: z
    .array(z.object({ sku: z.string().min(1).max(64), qty: z.number().int().min(1).max(99) }))
    .min(1)
    .max(50),
  idempotencyKey: z.string().min(8).max(40),
  claimTtlSeconds: z.number().int().min(60).max(3600).optional(),
})

export async function POST(request: Request) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    const staff = await requireStaff('associate')
    await enforce('staffOrderCreate', staff.userId)

    const parsed = Body.safeParse(await readJson(request))
    if (!parsed.success) fail('invalid_request', parsed.error.message)

    const order = await createStoreOrder({
      lines: parsed.data.lines,
      idempotencyKey: parsed.data.idempotencyKey,
      storeId: staff.storeId,
      staffId: staff.userId,
      // 15 minutes by default: the customer may have to sign up before they can
      // claim, and a 5-minute window dead-ends real people.
      claimTtlSeconds: parsed.data.claimTtlSeconds ?? 900,
    })

    // The QR must resolve on the CUSTOMER's phone. payOrigin() pins it to
    // PAY_ORIGIN in production and validates the dev header fallback.
    const origin = payOrigin(request.headers)
    const qrUrl = `${origin}/pay/${order.claimToken}`

    // Rendered on a screen you control. Never print and leave a QR unattended —
    // a sticker over it ("quishing") is the real in-store threat, a physical
    // control not a code one. PNG data-URL is CSP-safe (img-src allows data:).
    const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M' })

    const rails = decideRails(order.amountPaise)

    return NextResponse.json({
      orderId: order.orderId,
      amountPaise: order.amountPaise,
      amountDisplay: formatINR(order.amountPaise),
      currency: order.currency,
      qrUrl,
      qrDataUrl,
      expiresInSeconds: parsed.data.claimTtlSeconds ?? 900,
      rails: { available: rails.available, blocked: rails.blocked },
      requestId,
    })
  } catch (err) {
    return errorResponse(err, requestId)
  }
}
