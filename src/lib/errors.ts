import { NextResponse } from 'next/server'

/**
 * Uniform error shape, and — importantly — a policy about what we tell the
 * client. Payment errors leak useful reconnaissance if we forward database
 * messages verbatim, so the wire response carries a stable code and a
 * customer-safe message while the detail goes to the log.
 */

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'conflict'
  | 'rate_limited'
  | 'authorization_replayed'
  | 'order_not_payable'
  | 'amount_mismatch'
  | 'risk_declined'
  | 'upstream_error'
  | 'internal'

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  rate_limited: 429,
  authorization_replayed: 409,
  order_not_payable: 409,
  amount_mismatch: 409,
  risk_declined: 422,
  upstream_error: 502,
  internal: 500,
}

const SAFE_MESSAGE: Record<ApiErrorCode, string> = {
  unauthenticated: 'Please sign in to continue.',
  forbidden: 'You do not have access to this.',
  not_found: 'Not found.',
  invalid_request: 'That request was not valid.',
  conflict: 'This order has already moved on. Refresh and try again.',
  rate_limited: 'Too many attempts. Please wait a moment.',
  authorization_replayed:
    'That confirmation has already been used. Please authorise the payment again.',
  order_not_payable: 'This order can no longer be paid.',
  amount_mismatch: 'The amount changed. Please review your order and try again.',
  risk_declined:
    'This order exceeds the amount we can accept online. Please contact us to complete a high-value purchase.',
  upstream_error: 'The payment provider is not responding. Please try again.',
  internal: 'Something went wrong on our side.',
}

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    /** Internal detail. Logged, never returned to the client. */
    readonly detail?: string,
  ) {
    super(detail ?? code)
    this.name = 'ApiError'
  }
}

export function fail(code: ApiErrorCode, detail?: string): never {
  throw new ApiError(code, detail)
}

export function errorResponse(err: unknown, requestId?: string): NextResponse {
  const code = classify(err)
  const detail = err instanceof Error ? err.message : String(err)

  // One structured line per failure. Wire this to your log drain.
  console.error(
    JSON.stringify({
      level: code === 'internal' || code === 'upstream_error' ? 'error' : 'warn',
      event: 'api_error',
      code,
      detail,
      requestId,
    }),
  )

  return NextResponse.json(
    { error: { code, message: SAFE_MESSAGE[code] }, requestId },
    { status: STATUS[code] },
  )
}

function classify(err: unknown): ApiErrorCode {
  if (err instanceof ApiError) return err.code

  // Map the SQLSTATEs our app.* functions deliberately raise.
  const pgCode = (err as { code?: string } | null)?.code
  const message = err instanceof Error ? err.message : ''

  if (pgCode === '23505') return 'authorization_replayed'
  if (pgCode === '42501') return 'order_not_payable'
  if (pgCode === '22023') {
    if (/amount/i.test(message)) return 'amount_mismatch'
    return 'invalid_request'
  }
  return 'internal'
}

/** Short correlation id for logs and support conversations. */
export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8)
}
