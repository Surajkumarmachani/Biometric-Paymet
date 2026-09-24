-- ============================================================================
-- 0011_retention.sql — make the daily sweep actually enforce retention.
--
-- Two holes this closes, both found while auditing docs/go-live-checklist.md:
--
-- 1. app.sweep_otp() was ORPHANED. 0004_otp.sql defines it under the comment
--    "Fold into app.sweep() housekeeping" — and nothing ever did. No route, no
--    worker, no cron called it. otp_challenges.identifier IS a raw email address
--    or phone number, so every code ever sent was accumulating personal data
--    forever under DPDP purpose limitation.
--
-- 2. auth_audit_log had NO retention at all. src/lib/audit.ts says "Set a
--    retention policy and enforce it in app.sweep()"; it was never written. The
--    table holds `ip` (inet) and `user_agent` on every auth attempt.
--
-- Both are now inside app.sweep(), which /api/internal/sweep already runs daily
-- (vercel.json, 03:17). No route change is required — the new argument has a
-- default, so `select app.sweep()` keeps working.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- RETENTION WINDOW — 400 days (13 months). NEEDS LEGAL SIGN-OFF, see the
-- go-live checklist. The number is a floor set by three things:
--
--   * a card chargeback can surface months after the payment, and arbitration
--     later still — audit rows ARE the dispute evidence, so purging inside that
--     window destroys your own defence
--   * one full Indian financial year plus a month of margin, so a FY audit can
--     always see the year it is auditing
--   * DPDP purpose limitation pulls the other way: do not keep it longer than
--     the purpose needs
--
-- Raise it only with a reason you can write down. Lower it only with a CA's
-- sign-off. Rows belonging to a DISPUTED order are exempt regardless — see the
-- delete below.
-- ----------------------------------------------------------------------------

create or replace function app.sweep(p_audit_retention_days int default 400)
  returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_challenges int;
  v_events     int;
  v_buckets    int;
  v_otp        int;
  v_audit      int;
begin
  delete from payment_challenges
   where expires_at < now() - interval '1 day';
  get diagnostics v_challenges = row_count;

  delete from razorpay_webhook_events
   where status = 'processed' and purge_after < now();
  get diagnostics v_events = row_count;

  delete from rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_buckets = row_count;

  -- Hole 1: the orphaned OTP purge, now actually reached.
  v_otp := app.sweep_otp();

  -- Hole 2: audit retention. The `not exists` clause is the important part —
  -- an order that was ever disputed keeps its full audit trail past the window,
  -- because that trail is the evidence you would answer the dispute with.
  -- order_id is null for events not tied to an order (rate_limited,
  -- webhook_rejected); those are purged on the window alone.
  delete from auth_audit_log a
   where a.created_at < now() - make_interval(days => p_audit_retention_days)
     and not exists (
       select 1 from disputes d where d.order_id = a.order_id
     );
  get diagnostics v_audit = row_count;

  return jsonb_build_object(
    'challenges_purged', v_challenges,
    'events_purged',     v_events,
    'buckets_purged',    v_buckets,
    'otp_purged',        v_otp,
    'audit_purged',      v_audit
  );
end
$$;

-- Supports the retention scan; partial-index-free because the predicate is a
-- moving window. auth_audit_user_idx is on (user_id, created_at) and cannot
-- serve a bare created_at range.
create index if not exists auth_audit_created_idx on auth_audit_log (created_at);

-- Redefining app.sweep() with a new signature creates a NEW function; the old
-- zero-argument one is replaced in place only if the signature matches, which
-- it does not (default args are part of the call, not the identity). Drop the
-- stale one so `select app.sweep()` is never ambiguous.
drop function if exists app.sweep();

revoke all on function app.sweep(int) from public;
grant execute on function app.sweep(int) to service_role;
