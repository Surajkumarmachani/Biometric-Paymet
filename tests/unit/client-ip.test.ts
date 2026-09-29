import { describe, it, expect, afterEach } from 'vitest'
import { clientIp, inetOrNull, UNKNOWN_IP } from '../../src/lib/client-ip'

/**
 * Unit: CLIENT IP (security review #2).
 *
 * The left end of X-Forwarded-For is attacker-controlled; only the entries our
 * own proxies append are trustworthy. These pin that a spoofed header can
 * neither pick the bucket nor break the audit insert.
 */

const h = (xff?: string, real?: string) => {
  const headers = new Headers()
  if (xff !== undefined) headers.set('x-forwarded-for', xff)
  if (real !== undefined) headers.set('x-real-ip', real)
  return headers
}

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS
})

describe('clientIp', () => {
  it('uses the address the proxy appended, not what the client sent', () => {
    // Client sent "1.2.3.4"; the platform appended the real 203.0.113.9.
    expect(clientIp(h('1.2.3.4, 203.0.113.9'))).toBe('203.0.113.9')
  })

  it('gives every spoofed value the same bucket', () => {
    const a = clientIp(h('10.0.0.1, 203.0.113.9'))
    const b = clientIp(h('10.0.0.2, 203.0.113.9'))
    const c = clientIp(h('evil, 10.0.0.3, 203.0.113.9'))
    expect(new Set([a, b, c]).size).toBe(1)
  })

  it('reads one hop further left behind a load balancer', () => {
    process.env.TRUSTED_PROXY_HOPS = '2'
    expect(clientIp(h('1.2.3.4, 203.0.113.9, 35.191.0.1'))).toBe('203.0.113.9')
  })

  it('handles a single-entry header (Vercel overwrites it)', () => {
    expect(clientIp(h('203.0.113.9'))).toBe('203.0.113.9')
    expect(clientIp(h('2001:db8::1'))).toBe('2001:db8::1')
  })

  it('collapses junk to one shared bucket instead of trusting it', () => {
    expect(clientIp(h('x'))).toBe(UNKNOWN_IP)
    expect(clientIp(h("'; drop table orders; --"))).toBe(UNKNOWN_IP)
    expect(clientIp(h(' , '))).toBe(UNKNOWN_IP)
  })

  it('falls back to x-real-ip, then to unknown', () => {
    expect(clientIp(h(undefined, '198.51.100.7'))).toBe('198.51.100.7')
    expect(clientIp(h(undefined, 'nope'))).toBe(UNKNOWN_IP)
    expect(clientIp(h())).toBe(UNKNOWN_IP)
  })

  it('ignores a nonsense hop count', () => {
    process.env.TRUSTED_PROXY_HOPS = '0'
    expect(clientIp(h('1.2.3.4, 203.0.113.9'))).toBe('203.0.113.9')
    process.env.TRUSTED_PROXY_HOPS = '99'
    expect(clientIp(h('1.2.3.4, 203.0.113.9'))).toBe(UNKNOWN_IP)
  })
})

describe('inetOrNull', () => {
  it('passes real IPs and nulls everything else, so the audit row still lands', () => {
    expect(inetOrNull('203.0.113.9')).toBe('203.0.113.9')
    expect(inetOrNull('x')).toBeNull()
    expect(inetOrNull('')).toBeNull()
    expect(inetOrNull(null)).toBeNull()
  })
})
