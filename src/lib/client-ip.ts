import { isIP } from 'node:net'

/**
 * The caller's IP, for rate-limit buckets and the audit log.
 *
 * X-Forwarded-For is a list that every proxy APPENDS to, so only the entries
 * our own infrastructure added can be trusted. The left end is whatever the
 * client typed. Reading entry [0] — which this used to do — let anyone send
 * `X-Forwarded-For: <random>` and get a fresh bucket on every request, which
 * made adminPerIp, claimPerIp and otpPerIp decorative.
 *
 * TRUSTED_PROXY_HOPS is how many proxies we run in front of the app, counted
 * from the right. The client's address is the entry the outermost one added:
 *
 *   * 1 (default) — Vercel (overwrites the header with the real address) and
 *     Cloud Run on its run.app URL (Google appends the real address last)
 *   * 2 — Cloud Run behind a Google external Application Load Balancer, which
 *     appends `<client>, <load balancer>`
 *
 * Verify on each new deployment: send a request with a fake X-Forwarded-For
 * and check that the audit log records your real IP, not the fake one.
 *
 * Anything that is not a well-formed IP collapses to 0.0.0.0. That shares one
 * (strict) bucket instead of minting a new one, and it keeps junk out of the
 * audit log's inet column, where a malformed value used to fail the whole row.
 */
export const UNKNOWN_IP = '0.0.0.0'

export function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for')
  if (xff) {
    const hops = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const candidate = hops[hops.length - trustedProxyHops()]
    return candidate && isIP(candidate) ? candidate : UNKNOWN_IP
  }
  const real = headers.get('x-real-ip')?.trim()
  return real && isIP(real) ? real : UNKNOWN_IP
}

/** For the audit log's inet column: a valid IP or null, never a value that fails the insert. */
export function inetOrNull(ip: string | null | undefined): string | null {
  return ip && isIP(ip) ? ip : null
}
