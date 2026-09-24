/**
 * Client-safe detector for Clerk's reverification "hint".
 *
 * When /api/pay/authorize needs a fresh step-up it returns the shape produced by
 * Clerk's reverificationError():
 *
 *   { clerk_error: { type: 'forbidden', reason: 'reverification-error', ... } }
 *
 * A fetch() wrapped in useReverification must RETURN this object (not throw) so
 * the hook recognises it, pops the step-up UI, and retries the request. We match
 * Clerk's own isReverificationHint here rather than import it, because
 * @clerk/shared/authorization-errors is not an exported subpath and would fail
 * to bundle on the client.
 */
export function isReverificationHint(x: unknown): boolean {
  if (!x || typeof x !== 'object' || !('clerk_error' in x)) return false
  const e = (x as { clerk_error?: { type?: string; reason?: string } }).clerk_error
  return e?.type === 'forbidden' && e?.reason === 'reverification-error'
}
