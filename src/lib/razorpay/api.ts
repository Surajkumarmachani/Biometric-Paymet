import 'server-only'
import { serverEnv } from '@/env'
import { toPaise, type Paise } from '@/lib/money'
import { ApiError } from '@/lib/errors'
import { scrubPII } from '@/lib/redact'

/**
 * Razorpay REST calls we actually depend on.
 *
 * Deliberately hand-rolled over fetch rather than using the SDK for reads:
 * the SDK is CJS + axios, its TypeScript defs are incomplete in places, and
 * these four calls are the entire surface we need. Basic auth, JSON bodies
 * (Razorpay moved off form-encoding in SDK 2.9.2).
 */

const BASE = 'https://api.razorpay.com/v1'

export type RazorpayPaymentStatus =
  | 'created'
  | 'authorized'
  | 'captured'
  | 'refunded'
  | 'failed'

export interface RazorpayPayment {
  id: string
  order_id: string | null
  status: RazorpayPaymentStatus
  amount: number
  currency: string
  method?: string
  captured?: boolean
  fee?: number | null
  tax?: number | null
  error_code?: string | null
  error_description?: string | null
  error_reason?: string | null
  acquirer_data?: Record<string, unknown> | null
}

export interface RazorpayOrder {
  id: string
  amount: number
  amount_paid: number
  amount_due: number
  currency: string
  receipt: string | null
  status: 'created' | 'attempted' | 'paid'
  attempts: number
}

function authHeader(): string {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = serverEnv()
  return `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64')}`
}

async function call<T>(
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: authHeader(),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  })

  const text = await res.text()
  if (!res.ok) {
    throw new ApiError(
      'upstream_error',
      `razorpay ${init?.method ?? 'GET'} ${path} -> ${res.status} ${scrubPII(text.slice(0, 500))}`,
    )
  }
  return JSON.parse(text) as T
}

/**
 * Create a Razorpay order.
 *
 * There is NO idempotency-key header for Payment Gateway APIs (only RazorpayX
 * Payouts has one). `receipt` is documented as "has to be unique" but
 * server-side enforcement is unconfirmed, so dedupe lives in our own database:
 * the caller inserts its idempotency_key row first and reuses the resulting
 * razorpay_order_id. We pass the same key as `receipt` for reconciliation.
 */
export async function createRazorpayOrder(args: {
  amountPaise: Paise
  currency: string
  receipt: string
  notes?: Record<string, string>
}): Promise<RazorpayOrder> {
  if (args.receipt.length > 40) {
    throw new ApiError('invalid_request', 'receipt exceeds Razorpay 40-char limit')
  }
  return call<RazorpayOrder>('/orders', {
    method: 'POST',
    body: {
      amount: args.amountPaise, // integer paise
      currency: args.currency,
      receipt: args.receipt,
      notes: args.notes ?? {},
      // partial_payment intentionally omitted (defaults false): our
      // amount-match guard in app.apply_payment_event assumes full capture.
    },
  })
}

export async function fetchPayment(paymentId: string): Promise<RazorpayPayment> {
  return call<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`)
}

/**
 * All payments for an order.
 *
 * This is the call that rescues the dominant UPI failure mode: the customer's
 * app took over, our browser callback never fired, and we never learned a
 * payment id. Because we reuse ONE Razorpay order per order across retries,
 * this can never miss an attempt.
 */
export async function fetchOrderPayments(
  razorpayOrderId: string,
): Promise<RazorpayPayment[]> {
  const res = await call<{ entity: string; count: number; items: RazorpayPayment[] }>(
    `/orders/${encodeURIComponent(razorpayOrderId)}/payments`,
  )
  return res.items ?? []
}

export async function refundPayment(args: {
  paymentId: string
  amountPaise?: Paise
  notes?: Record<string, string>
}): Promise<{ id: string; amount: number; status: string }> {
  return call(`/payments/${encodeURIComponent(args.paymentId)}/refund`, {
    method: 'POST',
    body: {
      ...(args.amountPaise !== undefined ? { amount: args.amountPaise } : {}),
      notes: args.notes ?? {},
    },
  })
}

export interface RazorpayDispute {
  id: string
  payment_id: string
  amount: number
  status: string
  respond_by?: number | null
}

/**
 * One dispute as Razorpay holds it NOW. The drain uses this instead of the
 * webhook payload's copy, so a late, reordered or replayed dispute event can
 * only ever apply the current status.
 */
export async function fetchDispute(disputeId: string): Promise<RazorpayDispute> {
  return call<RazorpayDispute>(`/disputes/${encodeURIComponent(disputeId)}`)
}

export interface RazorpaySettlement {
  id: string
  amount: number
  fees: number
  tax: number
  status: string
  utr?: string | null
  created_at?: number | null
}

/** Settlement summaries (money paid out to your bank). */
export async function fetchSettlements(params?: { from?: number; to?: number; count?: number }): Promise<RazorpaySettlement[]> {
  const q = new URLSearchParams()
  if (params?.from) q.set('from', String(params.from))
  if (params?.to) q.set('to', String(params.to))
  q.set('count', String(params?.count ?? 100))
  const res = await call<{ items: RazorpaySettlement[] }>(`/settlements?${q.toString()}`)
  return res.items ?? []
}

/**
 * Per-transaction settlement reconciliation report — the authoritative mapping
 * of each payment/refund to the settlement that paid it out, with the fee and
 * tax deducted. Field names are mapped defensively; validate against a real
 * response before trusting live reconciliation.
 */
export interface ReconRow {
  entity_id?: string
  payment_id?: string
  type?: string
  amount?: number
  credit?: number
  debit?: number
  fee?: number
  tax?: number
  settlement_id?: string | null
  settled_at?: number | null
}

export async function fetchSettlementRecon(params: { year: number; month: number; day?: number; count?: number }): Promise<ReconRow[]> {
  const q = new URLSearchParams()
  q.set('year', String(params.year))
  q.set('month', String(params.month))
  if (params.day) q.set('day', String(params.day))
  q.set('count', String(params.count ?? 1000))
  const res = await call<{ items: ReconRow[] }>(`/settlements/recon/combined?${q.toString()}`)
  return res.items ?? []
}

/** Normalise a payment for app.apply_payment_event. */
export function paymentToEvent(p: RazorpayPayment) {
  return {
    razorpayPaymentId: p.id,
    razorpayOrderId: p.order_id,
    status: p.status,
    amountPaise: toPaise(p.amount),
    currency: p.currency,
    method: p.method ?? null,
    error: {
      code: p.error_code ?? '',
      description: p.error_description ?? '',
      reason: p.error_reason ?? '',
    },
    acquirer: p.acquirer_data ?? {},
    feePaise: p.fee == null ? null : toPaise(p.fee),
    taxPaise: p.tax == null ? null : toPaise(p.tax),
  }
}
