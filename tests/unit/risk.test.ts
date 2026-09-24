import { describe, it, expect, afterEach } from 'vitest'
import { assessOrderAmount, maxOrderPaise, reviewThresholdPaise } from '../../src/lib/risk'

/**
 * Unit: RISK LAYER (S5).
 *
 * Pure policy, no DB. The cap is a strict greater-than so an order exactly at
 * the ceiling is allowed; high-value orders under the ceiling are flagged, not
 * blocked. Env overrides the numbers.
 */

const CAP = 20_000_000 // ₹2,00,000 default

afterEach(() => {
  delete process.env.RISK_MAX_ORDER_PAISE
  delete process.env.RISK_REVIEW_PAISE
})

describe('assessOrderAmount', () => {
  it('defaults the cap to ₹2,00,000', () => {
    expect(maxOrderPaise()).toBe(CAP)
  })

  it('allows an order exactly at the cap', () => {
    const d = assessOrderAmount(CAP)
    expect(d.allowed).toBe(true)
    expect(d.code).toBe('ok')
  })

  it('refuses an order one paisa over the cap', () => {
    const d = assessOrderAmount(CAP + 1)
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('amount_cap_exceeded')
    expect(d.flags).toContain('over_cap')
  })

  it('flags a high-value order (>= 80% of cap) but still allows it', () => {
    const d = assessOrderAmount(Math.floor(CAP * 0.8))
    expect(d.allowed).toBe(true)
    expect(d.flags).toContain('high_value')
  })

  it('does not flag an ordinary order', () => {
    const d = assessOrderAmount(4_500_000) // ₹45,000
    expect(d.allowed).toBe(true)
    expect(d.flags).not.toContain('high_value')
  })

  it('honours an env override of the cap', () => {
    process.env.RISK_MAX_ORDER_PAISE = '500000' // ₹5,000
    expect(maxOrderPaise()).toBe(500_000)
    expect(assessOrderAmount(600_000).allowed).toBe(false)
    expect(assessOrderAmount(500_000).allowed).toBe(true)
  })

  it('review threshold defaults to 80% of the cap and is overridable', () => {
    expect(reviewThresholdPaise()).toBe(Math.floor(CAP * 0.8))
    process.env.RISK_REVIEW_PAISE = '1000000'
    expect(reviewThresholdPaise()).toBe(1_000_000)
  })
})
