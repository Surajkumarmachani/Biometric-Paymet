import 'server-only'
import { sql, jsonb } from './db'

/**
 * Audit log. Two jobs: dispute evidence, and detecting the security signals the
 * threat model calls for (BE flag changes, counter regressions, UV failures,
 * replayed challenges).
 *
 * DPDP note: this table holds ip and user_agent. It is NOT exposed to end users
 * directly — 0001_schema.sql grants only a narrowed `my_security_events` view.
 * Set a retention policy and enforce it in app.sweep().
 */

export type AuditEvent =
  | 'order_created'
  | 'order_claimed'
  | 'claim_rejected'
  | 'authorization_recorded'
  | 'authorization_replayed'
  | 'razorpay_order_created'
  | 'razorpay_order_reused'
  | 'callback_verified'
  | 'callback_signature_invalid'
  | 'payment_captured'
  | 'payment_failed'
  | 'late_authorisation'
  | 'order_abandoned'
  | 'refund_initiated'
  | 'refund_requested'
  | 'refund_request_withdrawn'
  | 'refund_request_declined'
  | 'refund_request_approved'
  | 'dispute_opened'
  | 'webhook_rejected'
  | 'webhook_dead'
  | 'rate_limited'
  | 'risk_declined'
  | 'high_value_order'
  | 'invoice_issued'
  | 'credit_note_issued'
  | 'settlement_discrepancy'
  | 'passkey_register'
  | 'passkey_assert'
  | 'uv_fail'
  | 'challenge_replay'
  | 'be_flag_change'
  | 'counter_regression'
  | 'otp_fallback'

export interface AuditInput {
  event: AuditEvent
  outcome: 'success' | 'failure'
  userId?: string | null
  orderId?: string | null
  credentialId?: string | null
  ip?: string | null
  userAgent?: string | null
  detail?: Record<string, unknown>
}

/**
 * Never let an audit write break a payment. We log the failure and continue —
 * a lost audit row is bad; a customer charged with no order transition is worse.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await sql`
      insert into auth_audit_log
        (user_id, order_id, event, outcome, credential_id, ip, user_agent, detail)
      values (
        ${input.userId ?? null},
        ${input.orderId ?? null},
        ${input.event},
        ${input.outcome},
        ${input.credentialId ?? null},
        ${input.ip ?? null}::inet,
        ${input.userAgent ?? null},
        ${jsonb(input.detail ?? {})}::jsonb
      )
    `
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'audit_write_failed',
        auditEvent: input.event,
        detail: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

/**
 * Signals that should page someone rather than sit in a table.
 *
 * Always emits a structured `alert: true` log line (wire your drain to it). If
 * ALERT_WEBHOOK_URL is set (a Slack-compatible incoming webhook), it also pushes
 * the alert there — fire-and-forget: an alerting failure must never block or
 * throw inside a payment path. Runbooks per alert live in docs/runbooks.md.
 */
export function alertOn(
  event: AuditEvent,
  detail: Record<string, unknown>,
): void {
  console.error(JSON.stringify({ level: 'error', alert: true, event, ...detail }))

  const url = process.env.ALERT_WEBHOOK_URL
  if (!url) return
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: `🚨 *${event}*\n\`\`\`${JSON.stringify(detail, null, 2)}\`\`\``,
    }),
  }).catch((err) =>
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'alert_dispatch_failed',
        alertEvent: event,
        detail: err instanceof Error ? err.message : String(err),
      }),
    ),
  )
}
