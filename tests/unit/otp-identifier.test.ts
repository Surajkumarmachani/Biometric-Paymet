import { describe, it, expect, afterEach } from 'vitest'
import { normalizeIdentifier, smsAllowed } from '../../src/lib/otp'
import { LIMITS } from '../../src/lib/rate-limit'

/**
 * Unit: OTP IDENTIFIERS (security review #3, SMS pumping).
 *
 * Every OTP bucket and challenge row keys on the normalised identifier, so one
 * contact must have exactly one spelling, and SMS must stay inside the
 * countries we serve.
 */

afterEach(() => {
  delete process.env.OTP_SMS_ALLOWED_PREFIXES
})

describe('normalizeIdentifier', () => {
  it('gives every spelling of one Indian mobile the same identifier', () => {
    const spellings = ['+91 98765 43210', '+919876543210', '9876543210', '98765-43210', '(+91) 98765 43210']
    const ids = spellings.map((s) => normalizeIdentifier(s)?.identifier)
    expect(new Set(ids)).toEqual(new Set(['+919876543210']))
    expect(normalizeIdentifier('9876543210')?.channel).toBe('sms')
  })

  it('lower-cases and trims email', () => {
    expect(normalizeIdentifier('  Priya@Example.COM ')).toEqual({ identifier: 'priya@example.com', channel: 'email' })
  })

  it('keeps an explicit foreign number as E.164', () => {
    expect(normalizeIdentifier('+44 20 7946 0958')?.identifier).toBe('+442079460958')
  })

  it('rejects things that are neither', () => {
    for (const bad of ['hello', '12345', '0000000000', '+0123456789', 'a@b', '']) {
      expect(normalizeIdentifier(bad)).toBeNull()
    }
  })
})

describe('smsAllowed', () => {
  it('defaults to India only', () => {
    expect(smsAllowed('+919876543210')).toBe(true)
    expect(smsAllowed('+442079460958')).toBe(false)
    // A premium-rate range is exactly what a pumping loop would pick.
    expect(smsAllowed('+8823456789')).toBe(false)
  })

  it('takes an explicit allowlist', () => {
    process.env.OTP_SMS_ALLOWED_PREFIXES = '+91, +971'
    expect(smsAllowed('+971501234567')).toBe(true)
    expect(smsAllowed('+442079460958')).toBe(false)
  })
})

describe('otp limits', () => {
  it('caps each account below the global budget', () => {
    expect(LIMITS.otpPerUser.limit).toBeLessThan(LIMITS.otpGlobal.limit / 50)
  })
})
