-- ============================================================================
-- 0012_realtime_replica_identity.sql — make the staff terminal's live tile work.
--
-- THE BUG THIS FIXES (observed live, 2026-08-24)
--
-- A ₹1,005 in-store order was created 12:55:22, claimed 12:55:49, captured
-- 12:56:50 (receipt RL-2026-001023) — and the terminal tile still read CLAIMED
-- at 12:58:00, 70 seconds after the money landed. The associate had no way to
-- know the customer had paid.
--
-- The money path was never at fault: capture, receipt, ledger and invoice were
-- all correct. What failed was delivery of the Realtime UPDATE that
-- OrderTile.tsx subscribes to.
--
-- WHY
--
-- `orders` was already in the supabase_realtime publication (db:reset does
-- that), and the RLS policies both admit the row — so it LOOKED configured.
-- But Realtime must evaluate RLS against the changed row before it may deliver
-- a postgres_changes event, and with REPLICA IDENTITY DEFAULT the WAL carries
-- only the primary key. Unable to prove the subscriber is entitled to the row,
-- Realtime drops the event rather than risk leaking it. Silently. Which is the
-- correct security choice and a miserable failure mode: no error anywhere, the
-- tile just never updates.
--
-- REPLICA IDENTITY FULL puts the whole row in the WAL, so the policy can be
-- evaluated and the event delivered.
--
-- COST
--
-- FULL writes every column of the old row into the WAL on UPDATE/DELETE, so WAL
-- volume grows. At jewellery-retail order rates this is irrelevant. Do not
-- copy-paste this onto a high-churn table without thinking about it.
--
-- Only `orders` needs it: it is the sole table the browser subscribes to.
-- ============================================================================

alter table orders replica identity full;

-- Belt and braces: db:reset adds `orders` to the publication, but a database
-- restored or provisioned another way may not have it, and the symptom is
-- identical (silent no-op). Idempotent.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table orders;
  end if;
exception
  -- A local/vanilla Postgres (and the test shim) has no supabase_realtime
  -- publication at all. That is fine — Realtime is a hosted-Supabase concern
  -- and the gates do not exercise it.
  when undefined_object then null;
end
$$;
