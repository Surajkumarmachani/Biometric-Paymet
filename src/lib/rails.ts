import { formatINR, type Paise } from './money'

/**
 * Which payment rails are available for a given amount.
 *
 * This exists because UPI has a hard per-transaction ceiling that depends on
 * your merchant category, and a ₹2,00,001 order silently failing at the UPI app
 * is a terrible checkout experience. We decide server-side and tell the
 * customer why.
 *
 * ---------------------------------------------------------------------------
 * NPCI per-transaction limits, effective 15 September 2025:
 *
 *   Jewellery (MCC 5944)                    ₹2,00,000  (₹6,00,000 / day)
 *   Credit-card bill payment                ₹5,00,000
 *   Capital markets / insurance / GeM /
 *     travel / loan collection              ₹5,00,000
 *   All other P2M                           unchanged, commonly ₹1,00,000
 *
 * NOTE the trap: jewellery is ₹2,00,000, NOT ₹5,00,000. The ₹5,00,000 bucket is
 * capital markets, insurance, GeM, travel and credit-card bills. Getting MCC
 * 5944 makes UPI viable UP TO ₹2,00,000 — not across luxury ticket sizes.
 *
 * Individual banks may set LOWER limits inside the NPCI caps, so treat these as
 * an upper bound and always degrade gracefully on a real limit failure.
 *
 * ⚠️ Confirm your assigned MCC and your enabled per-transaction limit with your
 * acquirer IN WRITING, then set MERCHANT_MCC and override UPI_CAP_OVERRIDE_PAISE
 * if they give you a different number. Do not trust this table alone.
 * ---------------------------------------------------------------------------
 */

/** MCC → UPI per-transaction ceiling in paise. */
const UPI_PER_TXN_CAP_BY_MCC: Record<string, Paise> = {
  '5944': 20_000_000, // jewellery — ₹2,00,000
  '5413': 50_000_000, // credit-card bills — ₹5,00,000
  '6211': 50_000_000, // securities brokers
  '6300': 50_000_000, // insurance
  '6381': 50_000_000, // insurance premiums
}

/** Conservative default for a general merchant category. */
const UPI_DEFAULT_CAP: Paise = 10_000_000 // ₹1,00,000

/**
 * PhonePe and the other UPI apps let the payer authenticate with an on-device
 * biometric instead of the UPI PIN only below this amount. Above it, the PIN is
 * required. Purely informational — we cannot influence it — but it lets the UI
 * set an honest expectation about how many taps the customer is about to make.
 */
export const UPI_BIOMETRIC_CEILING: Paise = 500_000 // ₹5,000

export type Rail = 'upi' | 'card' | 'netbanking' | 'bank_transfer'

export interface RailDecision {
  /** Rails to offer, in the order they should be presented. */
  available: Rail[]
  /** Rails deliberately withheld, with a customer-safe explanation. */
  blocked: Array<{ rail: Rail; reason: string }>
  upiCapPaise: Paise
  /** True when the UPI payer is likely to get a biometric rather than a PIN. */
  upiBiometricLikely: boolean
  /** Razorpay Standard Checkout `config.display` hint. */
  preferred: Rail
}

export function upiCapFor(mcc: string | undefined): Paise {
  const override = process.env.UPI_CAP_OVERRIDE_PAISE
  if (override && /^\d+$/.test(override)) return Number(override)
  if (!mcc) return UPI_DEFAULT_CAP
  return UPI_PER_TXN_CAP_BY_MCC[mcc] ?? UPI_DEFAULT_CAP
}

export function decideRails(amountPaise: Paise, mcc?: string): RailDecision {
  const upiCapPaise = upiCapFor(mcc ?? process.env.MERCHANT_MCC)
  const available: Rail[] = []
  const blocked: RailDecision['blocked'] = []

  if (amountPaise <= upiCapPaise) {
    available.push('upi')
  } else {
    blocked.push({
      rail: 'upi',
      reason:
        `UPI is limited to ${formatINR(upiCapPaise)} per transaction for this ` +
        `merchant category, and this order is ${formatINR(amountPaise)}.`,
    })
  }

  // Cards and netbanking carry the high-ticket load. Both require issuer AFA —
  // an OTP, or a device biometric where the issuing bank runs a passkey ACS.
  available.push('card', 'netbanking')

  // Above the UPI cap, offer an explicit bank transfer as the honest fallback:
  // card limits also bind at luxury ticket sizes.
  if (amountPaise > upiCapPaise) available.push('bank_transfer')

  return {
    available,
    blocked,
    upiCapPaise,
    upiBiometricLikely: amountPaise <= UPI_BIOMETRIC_CEILING,
    preferred: available[0] ?? 'card',
  }
}

/**
 * What the customer is actually about to experience. Used for the "one gesture"
 * copy — kept honest, because the final authentication is always performed by
 * the customer's bank or UPI app and we do not control whether it is a
 * biometric or an OTP.
 */
export function expectedGestures(decision: RailDecision, rail: Rail): string {
  if (rail === 'upi') {
    return decision.upiBiometricLikely
      ? 'Your UPI app will ask for a fingerprint or face — no PIN, no OTP.'
      : 'Your UPI app will ask for your UPI PIN.'
  }
  if (rail === 'card') {
    return 'Your bank will confirm the payment — a fingerprint or face if your bank supports it, otherwise an OTP.'
  }
  if (rail === 'netbanking') return 'You will confirm in your bank’s login.'
  return 'You will be given account details to transfer to.'
}
