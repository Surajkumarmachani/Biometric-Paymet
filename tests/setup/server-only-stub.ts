/**
 * Stub for the `server-only` package under Vitest.
 *
 * `server-only` deliberately throws unless it is resolved via the
 * "react-server" export condition, which only Next.js sets. Its job is to make
 * "a secret-bearing module got imported into a Client Component" a BUILD error,
 * and it does that job in `next build` — which is where it matters.
 *
 * Aliasing it here (rather than adding 'react-server' to resolve.conditions)
 * keeps the override scoped to this one package instead of changing how react
 * and next themselves resolve.
 */
export {}
