-- ============================================================================
-- 0019 — grants are exactly what 0001/0005/0013 intend, on real Supabase too.
--
-- A hosted Supabase project gives `anon` and `authenticated` ALL privileges on
-- every table in `public` by default (its own default privileges), on top of
-- the narrow SELECTs these migrations grant. RLS stopped that from mattering on
-- every table but one: invoice_counters had no RLS, so if the Data API were
-- ever switched on, anyone could rewrite or TRUNCATE GST invoice numbering.
-- And app.api_key_hit (0014) kept Postgres's default EXECUTE-to-PUBLIC.
-- Neither was reachable (Data API off; no USAGE on schema app), but "safe
-- because a dashboard toggle is off" is not a property worth keeping.
--
-- So: strip everything from anon/authenticated, re-grant the intended reads,
-- put RLS on invoice_counters, and stop future objects inheriting the
-- defaults. service_role and the app's own connection are untouched.
-- ============================================================================

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- The intended surface (0001, 0013). RLS policies then narrow the rows.
grant select on products, stores to anon, authenticated;
grant select on app_users, orders, payment_attempts, webauthn_credentials to authenticated;
grant select on refund_requests to authenticated;
grant select on my_security_events to authenticated;

-- The one table that had no RLS. Service-role only, like api_keys.
alter table invoice_counters enable row level security;

-- 0014 created this without the revoke every other app.* function gets.
revoke all on function app.api_key_hit(text, int) from public;
grant execute on function app.api_key_hit(text, int) to service_role;

-- New tables / sequences / functions must not inherit Supabase's grants.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema app    revoke all on functions from public;
