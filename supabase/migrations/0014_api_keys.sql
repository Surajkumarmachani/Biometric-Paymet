-- ============================================================================
-- 0014_api_keys.sql — per-client API keys (desktop till, website, customers)
--
-- Identifies the CALLING APPLICATION, not the person. Staff and customers are
-- still Clerk users; a key never stands in for a login or a passkey step-up.
--
-- Same shape as claim tokens and OTP codes: only the sha256 of the key is
-- stored, so a database read cannot reconstruct a working key. The plaintext
-- is shown exactly once, at creation.
--
-- Rate limiting rides on the key row itself (a fixed 60s window), so a request
-- costs ONE round trip: look up, count, and limit in a single UPDATE.
--
-- Idempotent (create if not exists / create or replace).
-- ============================================================================

create table if not exists api_keys (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(name) between 1 and 100),
  key_hash           text not null unique,            -- sha256 hex; the key never lands here
  key_prefix         text not null,                   -- first chars, for telling keys apart in a list
  active             boolean not null default true,
  -- null = use the server default (RATE_LIMIT_PER_MIN). The website key is shared by
  -- every visitor's browser, so it needs a far higher ceiling than one till.
  rate_limit_per_min int check (rate_limit_per_min is null or rate_limit_per_min > 0),
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  request_count      bigint not null default 0,
  window_start       timestamptz,
  window_count       int not null default 0
);

alter table api_keys enable row level security;
-- service-role only: RLS on, no policies, no grants (mirrors otp_challenges).

-- ---------------------------------------------------------------------------
-- Check a presented key and count the request.
--
-- Returns {ok:true, id, name} or {ok:false, reason:'invalid'|'rate_limited',
-- retry_after}. A missing, unknown and revoked key are all 'invalid' — the
-- caller must not be able to tell a revoked key from a typo.
-- ---------------------------------------------------------------------------
create or replace function app.api_key_hit(
  p_key_hash      text,
  p_default_limit int
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_row api_keys;
begin
  update api_keys
     set window_count  = case when window_start is null or window_start <= now() - interval '60 seconds'
                              then 1 else window_count + 1 end,
         window_start  = case when window_start is null or window_start <= now() - interval '60 seconds'
                              then now() else window_start end,
         last_used_at  = now(),
         request_count = request_count + 1
   where key_hash = p_key_hash
     and active
  returning * into v_row;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  if v_row.window_count > coalesce(v_row.rate_limit_per_min, p_default_limit) then
    return jsonb_build_object(
      'ok', false,
      'reason', 'rate_limited',
      'retry_after', greatest(1, ceil(extract(epoch from
                       v_row.window_start + interval '60 seconds' - now()))::int)
    );
  end if;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'name', v_row.name);
end
$$;
