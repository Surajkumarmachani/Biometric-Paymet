import { fail } from './errors'

/**
 * Read a JSON request body, as a client error when it is not one.
 *
 * `await request.json()` throws a SyntaxError on a malformed body, which the
 * error classifier cannot place, so every typo from an API client became a
 * 500 "internal" — noise in the error log and a false alert, not a bug. It
 * also read bodies of any size up to the platform's limit (32MB on Cloud
 * Run). Nothing here takes more than a few hundred bytes of JSON.
 */
export const MAX_JSON_BYTES = 16 * 1024

export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) fail('invalid_request', 'request body too large')

  const text = await request.text()
  if (new TextEncoder().encode(text).length > maxBytes) fail('invalid_request', 'request body too large')
  try {
    return JSON.parse(text)
  } catch {
    fail('invalid_request', 'request body must be valid JSON')
  }
}
