/**
 * Environment-derived settings the middleware needs. Pure and edge-safe (no
 * node: imports), so they can be unit-tested and run in the middleware.
 */

/**
 * Which origins may call /api from a browser on another site.
 *
 * Unset or empty used to mean "any site". Now it means none: same-origin
 * calls (the website calling its own /api) never needed CORS, and desktop
 * apps are not browsers, so nothing legitimate depended on the open default.
 * `*` is still honoured when set on purpose.
 */
export function corsAllowList(raw = process.env.ALLOWED_ORIGINS): { any: boolean; origins: string[] } {
  const list = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return { any: list.includes('*'), origins: list.filter((s) => s !== '*') }
}

/**
 * This instance's Clerk Frontend API host, read from the publishable key.
 *
 * A Clerk publishable key is `pk_test_` / `pk_live_` + base64("<host>$").
 * The CSP used to allow `https://*.clerk.accounts.dev`, i.e. every Clerk dev
 * instance anyone can create in a minute — so an injected
 * `<script src="https://attacker.clerk.accounts.dev/x.js">` would have passed.
 * Pinning the one host this app actually uses closes that. A production
 * instance (clerk.<your-domain>) is picked up the same way.
 *
 * CLERK_FRONTEND_HOST overrides, for a proxied or custom Frontend API.
 */
export function clerkFrontendHost(
  publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  override = process.env.CLERK_FRONTEND_HOST,
): string | null {
  if (override?.trim()) return override.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const m = /^pk_(test|live)_(.+)$/.exec(publishableKey ?? '')
  if (!m) return null
  try {
    const decoded = atob(m[2]!)
    const host = decoded.replace(/\$$/, '')
    return /^[a-z0-9.-]+$/i.test(host) ? host : null
  } catch {
    return null
  }
}

/**
 * Origins whose Clerk session tokens this API accepts (Clerk checks the
 * token's `azp` claim against the list). Without it, a session token minted
 * for some other site on the same Clerk instance would be honoured here.
 *
 * Built from PAY_ORIGIN (the website), explicit ALLOWED_ORIGINS, and
 * CLERK_AUTHORIZED_PARTIES for anything else. Empty = not enforced (local dev).
 */
export function authorizedParties(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const out = new Set<string>()
  const add = (v?: string) => {
    if (!v) return
    try {
      const u = new URL(v.trim())
      if (u.protocol === 'https:' || u.protocol === 'http:') out.add(u.origin)
    } catch {
      /* not a URL: ignore */
    }
  }
  add(env.PAY_ORIGIN)
  for (const o of corsAllowList(env.ALLOWED_ORIGINS).origins) add(o)
  for (const o of (env.CLERK_AUTHORIZED_PARTIES ?? '').split(',')) add(o)
  return out.size ? [...out] : undefined
}
