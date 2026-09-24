-- ============================================================================
-- 0000_local_supabase_shim.sql
--
-- LOCAL TEST ONLY. Do NOT run this on Supabase.
--
-- Supabase already provides the `auth` schema, `auth.jwt()`, and the `anon` /
-- `authenticated` / `service_role` roles. This file recreates just enough of
-- them on a vanilla Postgres so the RLS policies in 0001 can be executed and
-- verified by the test suite instead of merely asserted.
--
-- `auth.jwt()` mirrors Supabase's real implementation: it reads the claims that
-- PostgREST sets as a local GUC on each request.
-- ============================================================================

create schema if not exists auth;

create or replace function auth.jwt() returns jsonb
  language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

-- Supabase's auth.uid() casts the `sub` claim to uuid. Present here only so the
-- test suite can demonstrate why it is the WRONG helper for a Clerk subject.
create or replace function auth.uid() returns uuid
  language sql stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

-- Roles are CLUSTER-global, but every gate suite migrates its OWN database and
-- the suites run in parallel — so `if not exists (...) then create role` is a
-- check-then-act race across sessions. Two workers both see the role missing,
-- both issue CREATE ROLE, and the loser dies on
-- `duplicate key value violates unique constraint "pg_authid_rolname_index"`,
-- failing whole suites for no reason. Two layers fix it:
--
--   1. An advisory lock serialises role creation across concurrent sessions.
--      It is transaction-scoped, and this whole file runs as one implicit
--      transaction, so it releases when the file finishes.
--   2. Each CREATE ROLE still swallows the duplicate, because a session that
--      already passed the check before anyone took the lock can arrive here
--      with the role now present. Postgres reports that either as
--      duplicate_object (the friendly check) or unique_violation (the index),
--      depending on who lost the race, so both are caught.
do $$
begin
  perform pg_advisory_xact_lock(4207201);

  begin
    create role anon nologin noinherit;
  exception when duplicate_object or unique_violation then null;
  end;

  begin
    create role authenticated nologin noinherit;
  exception when duplicate_object or unique_violation then null;
  end;

  begin
    -- BYPASSRLS is what makes server-side writes work while clients are denied.
    create role service_role nologin noinherit bypassrls;
  exception when duplicate_object or unique_violation then null;
  end;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;
