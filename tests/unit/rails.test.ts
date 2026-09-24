import { describe, it, expect, afterEach } from 'vitest'
import { decideRails, upiCapFor, UPI_BIOMETRIC_CEILING } from '@/lib/rails'
import { formatINR, toPaise, rupees } from '@/lib/money'

/**
 * Gate: RAIL ROUTING and the UPI ceiling.
 *
 * This encodes the correction that inverted a planning conclusion: jewellery
 * (MCC 5944) is ₹2,00,000 per transaction, NOT ₹5,00,000. Getting MCC 5944
 * makes UPI viable UP TO ₹2,00,000 — not across luxury ticket sizes.
 */

afterEach(() => {
  delete process.env.UPI_CAP_OVERRIDE_PAISE
  delete process.env.MERCHANT_MCC
})

describe('UPI per-transaction cap', () => {
  it('jewellery (5944) is ₹2,00,000 — NOT ₹5,00,000', () => {
    expect(upiCapFor('5944')).toBe(20_000_000)
    expect(formatINR(upiCapFor('5944'))).toBe('₹2,00,000.00')
  })

  it('the ₹5,00,000 bucket is insurance / capital markets / card bills', () => {
    expect(upiCapFor('5413')).toBe(50_000_000)
    expect(upiCapFor('6300')).toBe(50_000_000)
    expect(upiCapFor('6211')).toBe(50_000_000)
  })

  it('an unknown MCC falls back conservatively to ₹1,00,000', () => {
    expect(upiCapFor('9999')).toBe(10_000_000)
    expect(upiCapFor(undefined)).toBe(10_000_000)
  })

  it('honours an acquirer-confirmed override', () => {
    process.env.UPI_CAP_OVERRIDE_PAISE = '7500000'
    expect(upiCapFor('5944')).toBe(7_500_000)
  })
})

describe('rail routing', () => {
  it('offers UPI at exactly the cap', () => {
    const d = decideRails(rupees(200_000), '5944')
    expect(d.available).toContain('upi')
    expect(d.blocked).toHaveLength(0)
    expect(d.preferred).toBe('upi')
  })

  it('blocks UPI one paisa over the cap and explains why', () => {
    const d = decideRails(rupees(200_000) + 1, '5944')
    expect(d.available).not.toContain('upi')
    expect(d.blocked[0]!.rail).toBe('upi')
    expect(d.blocked[0]!.reason).toContain('₹2,00,000.00')
    // Above the cap the customer must still be able to pay.
    expect(d.available).toContain('card')
    expect(d.available).toContain('bank_transfer')
    expect(d.preferred).toBe('card')
  })

  it('a ₹3,50,000 order gets no UPI at all', () => {
    const d = decideRails(rupees(350_000), '5944')
    expect(d.available).toEqual(['card', 'netbanking', 'bank_transfer'])
  })

  it('always leaves at least one rail available', () => {
    for (const amount of [1, rupees(1), rupees(5_000), rupees(200_000), rupees(10_000_000)]) {
      expect(decideRails(amount, '5944').available.length).toBeGreaterThan(0)
    }
  })

  it('flags where a UPI biometric is likely rather than a PIN', () => {
    expect(decideRails(rupees(4_999), '5944').upiBiometricLikely).toBe(true)
    expect(decideRails(rupees(5_000), '5944').upiBiometricLikely).toBe(true)
    // PhonePe's on-device biometric stops at ₹5,000.
    expect(decideRails(rupees(5_001), '5944').upiBiometricLikely).toBe(false)
    expect(UPI_BIOMETRIC_CEILING).toBe(500_000)
  })
})

describe('money', () => {
  it('formats with Indian digit grouping', () => {
    expect(formatINR(0)).toBe('₹0.00')
    expect(formatINR(100)).toBe('₹1.00')
    expect(formatINR(123_456)).toBe('₹1,234.56')
    expect(formatINR(10_000_000)).toBe('₹1,00,000.00')
    expect(formatINR(20_000_000)).toBe('₹2,00,000.00')
    expect(formatINR(350_00_000)).toBe('₹3,50,000.00')
  })

  it('reads bigint strings from the database losslessly', () => {
    expect(toPaise('20000000')).toBe(20_000_000)
    expect(toPaise(20_000_000)).toBe(20_000_000)
    expect(toPaise(BigInt(20_000_000))).toBe(20_000_000)
  })

  it('refuses anything that is not integer paise', () => {
    for (const bad of ['12.5', 'abc', '', '1e5', null, undefined, {}, NaN, 1.5, -1, '-5']) {
      expect(() => toPaise(bad)).toThrow()
    }
  })

  it('refuses sub-paise precision', () => {
    expect(() => rupees(1.005)).toThrow()
    expect(rupees(1.5)).toBe(150)
  })
})
