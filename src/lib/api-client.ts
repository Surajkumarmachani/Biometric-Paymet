/**
 * Browser-side fetch for our own /api routes. Adds the website's X-API-Key.
 *
 * The key is read from a <meta> tag the root layout renders per request (from
 * WEB_API_KEY), not inlined at build time, so rotating it is an env change and
 * a restart, never a rebuild.
 *
 * The website key is not a secret — anything shipped to a browser is public.
 * It identifies and meters the website as a client; who the user is remains
 * Clerk's job, and money still needs a passkey step-up.
 */
let cached: string | null | undefined

function webApiKey(): string | null {
  if (cached !== undefined) return cached
  cached =
    typeof document === 'undefined'
      ? null
      : document.querySelector('meta[name="regal-api-key"]')?.getAttribute('content') || null
  return cached
}

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const key = webApiKey()
  if (key) headers.set('X-API-Key', key)
  return fetch(input, { ...init, headers })
}
