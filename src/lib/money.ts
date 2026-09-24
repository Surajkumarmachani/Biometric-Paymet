/**
 * Money is integer paise. Never a float, never rupees, never a Number parsed
 * from user input.
 *
 * Razorpay's `amount` field is in currency subunits: ₹2,00,000 => 20000000.
 */

export type Paise = number

const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER

/**
 * Normalise a paise value arriving from the database (postgres.js returns
 * bigint columns as strings) or from an API response.
 *
 * Throws rather than coercing: a NaN amount that reaches Razorpay is worse
 * than a 500.
 */
export function toPaise(value: unknown): Paise {
  if (typeof value === 'number') {
    assertIntegerPaise(value)
    return value
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(MAX_SAFE_PAISE)) throw new Error('amount exceeds safe integer range')
    const n = Number(value)
    assertIntegerPaise(n)
    return n
  }
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value.trim())) {
      throw new Error(`not an integer paise string: ${JSON.stringify(value)}`)
    }
    const n = Number(value.trim())
    assertIntegerPaise(n)
    return n
  }
  throw new Error(`cannot read paise from ${typeof value}`)
}

function assertIntegerPaise(n: number): void {
  if (!Number.isFinite(n)) throw new Error('amount is not finite')
  if (!Number.isInteger(n)) throw new Error(`amount is not an integer paise value: ${n}`)
  if (n < 0) throw new Error(`amount is negative: ${n}`)
  if (n > MAX_SAFE_PAISE) throw new Error('amount exceeds safe integer range')
}

/** ₹2,00,000.00 — Indian digit grouping, for display only. */
export function formatINR(paise: Paise): string {
  assertIntegerPaise(paise)
  const rupees = Math.floor(paise / 100)
  const fraction = String(paise % 100).padStart(2, '0')
  return `₹${groupIndian(rupees)}.${fraction}`
}

function groupIndian(n: number): string {
  const s = String(n)
  if (s.length <= 3) return s
  const last3 = s.slice(-3)
  const rest = s.slice(0, -3)
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`
}

export const RUPEE = 100
export function rupees(n: number): Paise {
  if (!Number.isInteger(n * 100)) throw new Error('sub-paise precision requested')
  return Math.round(n * 100)
}
