import { fail } from './errors'

/**
 * The origin the customer's phone opens from the terminal's QR.
 *
 * It used to be built from Host / X-Forwarded-Host / X-Forwarded-Proto on
 * every request. Those are request headers: a proxy that passes them through,
 * or any client calling the API directly (the desktop till), could make the
 * QR — and the terminal's "open link" href — point at a phishing domain or a
 * `javascript:` URL. A QR is the one link customers follow without reading it.
 *
 *   * PAY_ORIGIN set  — used as-is, always. Production must set it: with the
 *     website on Vercel and the API on Cloud Run, the API's own host is not
 *     where /pay/[token] should open anyway.
 *   * PAY_ORIGIN unset, production — refuse, rather than trust headers.
 *   * PAY_ORIGIN unset, dev — derive from headers so a phone on a LAN IP or a
 *     tunnel gets a scannable link, but only http(s) and a plain host[:port].
 */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i

export function payOrigin(headers: Headers): string {
  const configured = process.env.PAY_ORIGIN?.trim()
  if (configured) {
    const u = safeUrl(configured)
    if (!u) fail('internal', 'PAY_ORIGIN must be an http(s) origin')
    return u.origin
  }

  if (process.env.NODE_ENV === 'production') {
    fail('internal', 'PAY_ORIGIN unset: refusing to build a QR link from request headers')
  }

  const host = (headers.get('x-forwarded-host') ?? headers.get('host') ?? '').split(',')[0]!.trim()
  if (!HOST_RE.test(host)) fail('invalid_request', 'unusable host for the payment link')

  const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]!.trim().toLowerCase()
  const local = /^(localhost|127\.|192\.168\.|10\.|172\.)/.test(host)
  const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : local ? 'http' : 'https'
  return `${proto}://${host}`
}

function safeUrl(s: string): URL | null {
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}
