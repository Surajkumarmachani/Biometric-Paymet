import { describe, it, expect, afterEach } from 'vitest'
import { staffMaySee, assertInternalSecret, MIN_SECRET_LENGTH } from '../../src/lib/auth'
import { requireAdmin } from '../../src/lib/api-keys'
import { payOrigin } from '../../src/lib/pay-origin'

/**
 * Unit: ACCESS HARDENING (security review #6, #8, #10).
 */

const STORE_A = '11111111-1111-1111-1111-111111111111'
const STORE_B = '22222222-2222-2222-2222-222222222222'

const env = process.env as Record<string, string | undefined>
const saved = { ...process.env }
afterEach(() => {
  for (const k of ['PAY_ORIGIN', 'NODE_ENV', 'ADMIN_TOKEN', 'INTERNAL_TASK_SECRET']) env[k] = saved[k]
})

describe('staffMaySee (#6)', () => {
  it('scopes associates to their own store', () => {
    const assoc = { storeId: STORE_A, role: 'associate' as const }
    expect(staffMaySee(assoc, STORE_A)).toBe(true)
    expect(staffMaySee(assoc, STORE_B)).toBe(false)
    // A web order has no store — not an associate's to see.
    expect(staffMaySee(assoc, null)).toBe(false)
  })

  it('lets managers and admins see any store', () => {
    for (const role of ['manager', 'admin'] as const) {
      expect(staffMaySee({ storeId: STORE_A, role }, STORE_B)).toBe(true)
      expect(staffMaySee({ storeId: STORE_A, role }, null)).toBe(true)
    }
  })

  it('denies non-staff', () => {
    expect(staffMaySee(null, STORE_A)).toBe(false)
  })
})

describe('payOrigin (#8)', () => {
  const h = (o: Record<string, string>) => new Headers(o)

  it('always uses PAY_ORIGIN when set, whatever the headers say', () => {
    env.PAY_ORIGIN = 'https://app.regallab.example/'
    expect(payOrigin(h({ host: 'evil.example', 'x-forwarded-host': 'evil.example' }))).toBe(
      'https://app.regallab.example',
    )
  })

  it('refuses to trust headers in production', () => {
    delete env.PAY_ORIGIN
    env.NODE_ENV = 'production'
    expect(() => payOrigin(h({ host: 'app.regallab.example' }))).toThrow()
  })

  it('rejects a non-http(s) PAY_ORIGIN', () => {
    env.PAY_ORIGIN = 'javascript:alert(1)'
    expect(() => payOrigin(h({}))).toThrow()
  })

  it('in dev, derives from headers but only as http(s)://host', () => {
    delete env.PAY_ORIGIN
    env.NODE_ENV = 'development'
    expect(payOrigin(h({ host: 'abc.ngrok-free.dev' }))).toBe('https://abc.ngrok-free.dev')
    expect(payOrigin(h({ host: '192.168.1.5:3000' }))).toBe('http://192.168.1.5:3000')
    // A hostile proto is ignored, not interpolated into the link.
    expect(payOrigin(h({ host: 'abc.ngrok-free.dev', 'x-forwarded-proto': 'javascript:alert(1)//' }))).toBe(
      'https://abc.ngrok-free.dev',
    )
    for (const bad of ['evil.example/phish?', 'a b', 'x@evil.example', '']) {
      expect(() => payOrigin(h({ host: bad }))).toThrow()
    }
  })
})

describe('secret minimums (#10)', () => {
  it('turns the admin API off when ADMIN_TOKEN is short', async () => {
    env.ADMIN_TOKEN = 'short'
    const req = new Request('http://x/api/admin/keys', { headers: { 'x-admin-token': 'short' } })
    await expect(requireAdmin(req)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses the crons when INTERNAL_TASK_SECRET is short, even with a matching header', () => {
    env.INTERNAL_TASK_SECRET = 'tooshort'
    expect(() => assertInternalSecret('tooshort')).toThrow()
  })

  it('accepts a long enough secret', () => {
    const s = 'x'.repeat(MIN_SECRET_LENGTH)
    env.INTERNAL_TASK_SECRET = s
    expect(() => assertInternalSecret(s)).not.toThrow()
    expect(() => assertInternalSecret('y'.repeat(MIN_SECRET_LENGTH))).toThrow()
  })
})
