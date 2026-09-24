import 'server-only'
import type { Paise } from './money'

/**
 * Risk layer (S5 hardening).
 *
 * A merchant-side control that sits in front of order creation: it refuses
 * orders above a hard ceiling and flags high-value ones for review. This is
 * separate from the UPI rail cap in rails.ts — that decides which *rail* an
 * amount can use; this decides whether the order is allowed at all.
 *
 * It lives in the service layer, not in SQL, on purpose: risk is a policy that
 * needs context (amount today, velocity) and must stay tunable without a
 * migration. The SQL money invariants (pricing, single-use, exactly-once) are
 * unchanged.
 */

/** Per-order hard ceiling in paise. Default ₹2,00,000. Override with env. */
export function maxOrderPaise(): number {
  const v = Number(process.env.RISK_MAX_ORDER_PAISE)
  return Number.isInteger(v) && v > 0 ? v : 20_000_000
}

/** At or above this, an order is allowed but flagged for review. Default 80% of the cap. */
export function reviewThresholdPaise(): number {
  const v = Number(process.env.RISK_REVIEW_PAISE)
  if (Number.isInteger(v) && v > 0) return v
  return Math.floor(maxOrderPaise() * 0.8)
}

export type RiskCode = 'ok' | 'amount_cap_exceeded'

export interface RiskDecision {
  allowed: boolean
  code: RiskCode
  /** Non-blocking signals worth surfacing, e.g. 'high_value'. */
  flags: string[]
  maxOrderPaise: number
}

/**
 * Assess an order by its server-priced amount.
 *
 * The amount is strictly greater-than the cap to fail, so an order *exactly* at
 * the cap is allowed (₹2,00,000 passes; ₹2,00,000.01 does not).
 */
export function assessOrderAmount(amountPaise: Paise): RiskDecision {
  const max = maxOrderPaise()
  if (amountPaise > max) {
    return { allowed: false, code: 'amount_cap_exceeded', flags: ['over_cap'], maxOrderPaise: max }
  }
  const flags: string[] = []
  if (amountPaise >= reviewThresholdPaise()) flags.push('high_value')
  return { allowed: true, code: 'ok', flags, maxOrderPaise: max }
}
