/**
 * Keep personal data out of logs (DPDP purpose limitation).
 *
 * Logs ship to Cloud Logging / Vercel and to the alert webhook, are read by
 * people who never need a customer's full email or number, and outlive the
 * rows they describe. A masked value still tells an operator which contact an
 * event was about, which is all a log line is for.
 */

/** `priya@example.com` -> `p***@example.com`; `+919876543210` -> `+91******3210`. */
export function maskIdentifier(s: string | null | undefined): string {
  if (!s) return ''
  const at = s.indexOf('@')
  if (at > 0) return `${s[0]}***${s.slice(at)}`
  const digits = s.replace(/\D/g, '')
  if (digits.length >= 7) {
    const cc = s.startsWith('+') ? s.slice(0, 3) : ''
    return `${cc}${'*'.repeat(Math.max(digits.length - 4 - (cc ? 2 : 0), 2))}${digits.slice(-4)}`
  }
  return s.length <= 2 ? '***' : `${s.slice(0, 2)}***`
}

/**
 * Mask every email address and phone number inside free text (upstream error
 * bodies, alert payloads). Phones are `+<8-15 digits>` or a bare 10-digit
 * Indian mobile — deliberately narrow, so paise amounts, unix timestamps and
 * receipt numbers in the same line survive.
 */
export function scrubPII(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => maskIdentifier(m))
    .replace(/\+\d{8,15}(?!\d)|(?<![\d.])[6-9]\d{9}(?!\d)/g, (m) => maskIdentifier(m))
}
