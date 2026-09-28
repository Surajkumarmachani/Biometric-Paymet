import { createHash, randomBytes } from 'node:crypto'

/**
 * API key format, shared by the server and `scripts/api-keys.mts`.
 *
 * No `server-only` import: the CLI runs outside Next. Nothing here touches the
 * database or the environment, so it is safe to share.
 *
 * `rlk_` + 32 random bytes (base64url). The prefix makes a leaked key
 * recognisable in logs and to secret scanners; the 256 bits of entropy are why
 * a plain sha256 (not bcrypt) is the right storage hash — there is no
 * dictionary to attack.
 */
export const API_KEY_PREFIX = 'rlk_'

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString('base64url')
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** What a list shows so you can tell keys apart without revealing them. */
export function displayPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX.length + 6)
}
