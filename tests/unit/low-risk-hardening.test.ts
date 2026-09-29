import { describe, it, expect } from 'vitest'
import { corsAllowList, clerkFrontendHost, authorizedParties } from '../../src/lib/edge-config'
import { maskIdentifier, scrubPII } from '../../src/lib/redact'
import { readJson, MAX_JSON_BYTES } from '../../src/lib/body'
import { mayLogCodes } from '../../src/lib/otp'
import { staffMayRefund } from '../../src/lib/auth'

/**
 * Unit: the "low risk" review items, plus manager store scope in the UI.
 */

const STORE_A = '11111111-1111-1111-1111-111111111111'
const STORE_B = '22222222-2222-2222-2222-222222222222'

describe('CORS default', () => {
  it('allows no foreign origin when ALLOWED_ORIGINS is unset or empty', () => {
    expect(corsAllowList(undefined)).toEqual({ any: false, origins: [] })
    expect(corsAllowList('')).toEqual({ any: false, origins: [] })
  })
  it('still honours an explicit list or *', () => {
    expect(corsAllowList('https://a.example, https://b.example').origins).toEqual([
      'https://a.example',
      'https://b.example',
    ])
    expect(corsAllowList('*').any).toBe(true)
  })
})

describe('Clerk host for the CSP', () => {
  const pk = (host: string, mode = 'test') => `pk_${mode}_${btoa(`${host}$`)}`
  it('pins the instance host from the publishable key', () => {
    expect(clerkFrontendHost(pk('clear-tomcat-3271.clerk.accounts.dev'), undefined)).toBe(
      'clear-tomcat-3271.clerk.accounts.dev',
    )
    expect(clerkFrontendHost(pk('clerk.regallab.example', 'live'), undefined)).toBe('clerk.regallab.example')
  })
  it('prefers an explicit override and rejects junk', () => {
    expect(clerkFrontendHost(pk('x.clerk.accounts.dev'), 'https://clerk.custom.example/')).toBe('clerk.custom.example')
    expect(clerkFrontendHost('not-a-key', undefined)).toBeNull()
    expect(clerkFrontendHost(`pk_test_${btoa('evil host; script-src *$')}`, undefined)).toBeNull()
  })
})

describe('Clerk authorizedParties', () => {
  it('is built from the website origin, explicit CORS origins and extras', () => {
    expect(
      authorizedParties({
        PAY_ORIGIN: 'https://app.regallab.example/',
        ALLOWED_ORIGINS: 'https://partner.example, *',
        CLERK_AUTHORIZED_PARTIES: 'https://desk.regallab.example, nonsense',
      }),
    ).toEqual(['https://app.regallab.example', 'https://partner.example', 'https://desk.regallab.example'])
  })
  it('is off when nothing is configured (local dev)', () => {
    expect(authorizedParties({})).toBeUndefined()
  })
})

describe('PII in logs', () => {
  it('masks emails and phone numbers', () => {
    expect(maskIdentifier('priya@example.com')).toBe('p***@example.com')
    expect(maskIdentifier('+919876543210')).toBe('+91******3210')
    expect(scrubPII('To +919876543210 or 9876543210, cc priya@example.com')).not.toMatch(/9876543210|priya@/)
  })
  it('leaves amounts, timestamps, ids and IPs readable', () => {
    const line = '{"amountPaise":20000000,"created_at":1755000000,"ip":"203.0.113.9","userId":"user_2abc"}'
    expect(scrubPII(line)).toBe(line)
  })
})

describe('OTP codes in logs', () => {
  it('are only printed on a developer machine', () => {
    expect(mayLogCodes('development')).toBe(true)
    expect(mayLogCodes('test')).toBe(true)
    for (const env of ['production', 'staging', '']) expect(mayLogCodes(env)).toBe(false)
  })
})

describe('readJson', () => {
  const req = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://x/api', { method: 'POST', body, headers })
  it('parses valid JSON', async () => {
    expect(await readJson(req('{"a":1}'))).toEqual({ a: 1 })
  })
  it('turns malformed JSON into a 400, not a 500', async () => {
    await expect(readJson(req('{bad'))).rejects.toMatchObject({ code: 'invalid_request' })
  })
  it('refuses oversized bodies', async () => {
    await expect(readJson(req('x'.repeat(MAX_JSON_BYTES + 1)))).rejects.toMatchObject({ code: 'invalid_request' })
  })
})

describe('staffMayRefund (manager = own store)', () => {
  it('admins refund anything; managers only their own store; never a web order', () => {
    expect(staffMayRefund({ storeId: STORE_A, role: 'admin' }, STORE_B)).toBe(true)
    expect(staffMayRefund({ storeId: STORE_A, role: 'admin' }, null)).toBe(true)
    expect(staffMayRefund({ storeId: STORE_A, role: 'manager' }, STORE_A)).toBe(true)
    expect(staffMayRefund({ storeId: STORE_A, role: 'manager' }, STORE_B)).toBe(false)
    expect(staffMayRefund({ storeId: STORE_A, role: 'manager' }, null)).toBe(false)
    expect(staffMayRefund({ storeId: STORE_A, role: 'associate' }, STORE_A)).toBe(false)
  })
})
