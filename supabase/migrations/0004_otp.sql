-- ============================================================================
-- 0004_otp.sql — OTP fallback (S2 Identity)
--
-- A merchant-side, rate-limited one-time-code fallback for when a customer's
-- device cannot do passkeys. It authenticates the customer to US; it is NOT a
-- payment authorization factor (auth_kind has no 'otp' member, and threat 19
-- requires a fresh passkey/reverification per payment). Nothing here touches
-- the order state machine.
--
-- Same shape as payment_challenges: the code hash is stored, never the code;
-- consumption is a single atomic UPDATE so check-then-use cannot race; and an
-- attempt cap burns the challenge on brute force.
--
-- Idempotent (create if not exists / create or replace) so it can be applied to
-- a project that already has 0001..0003 without a full db:reset.
-- ============================================================================

create table if not exists otp_challenges (
  id           uuid primary key default gen_random_uuid(),
  identifier   text not null,                     -- email / phone / opaque subject
  purpose      text not null default 'verify',    -- verify | fallback_signin | ...
  code_hash    text not null,                     -- sha256 hex; the code never lands here
  user_id      text,                              -- Clerk subject when known
  attempts     int  not null default 0,
  max_attempts int  not null default 5,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz
);

-- One active (unconsumed, unexpired) code per identifier+purpose is the useful
-- state; the lookup rides this index.
create index if not exists otp_active_idx
  on otp_challenges (identifier, purpose)
  where consumed_at is null;

alter table otp_challenges enable row level security;
-- service-role only: RLS on, no policies, no grants (mirrors payment_challenges).

-- ---------------------------------------------------------------------------
-- Create a challenge. Invalidates any prior active code for the same
-- identifier+purpose so only the most recently sent code can ever verify.
-- ---------------------------------------------------------------------------
create or replace function app.create_otp_challenge(
  p_identifier   text,
  p_code_hash    text,
  p_user_id      text default null,
  p_purpose      text default 'verify',
  p_ttl_seconds  int  default 300,      -- 5 minutes
  p_max_attempts int  default 5
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_row otp_challenges;
begin
  if p_identifier is null or length(p_identifier) = 0 then
    raise exception 'identifier required' using errcode = '22023';
  end if;

  -- Burn any prior active code: a freshly sent code supersedes the last one.
  update otp_challenges
     set consumed_at = now()
   where identifier = p_identifier
     and purpose    = p_purpose
     and consumed_at is null;

  insert into otp_challenges (
    identifier, purpose, code_hash, user_id, max_attempts, expires_at
  ) values (
    p_identifier, p_purpose, p_code_hash, p_user_id, p_max_attempts,
    now() + make_interval(secs => p_ttl_seconds)
  ) returning * into v_row;

  return jsonb_build_object(
    'id',         v_row.id,
    'expires_at', v_row.expires_at
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Verify a code. One atomic statement per outcome:
--   * no active challenge            -> {ok:false, reason:'no_active'}
--   * attempts already at the cap    -> burn, {ok:false, reason:'too_many_attempts'}
--   * code matches                   -> consume, {ok:true, user_id}
--   * code mismatches                -> increment (burn if it hits the cap),
--                                       {ok:false, reason:'mismatch', remaining}
-- Locking the row FOR UPDATE makes concurrent verifies serialise, so the
-- attempt counter cannot be raced past the cap.
-- ---------------------------------------------------------------------------
create or replace function app.verify_otp_challenge(
  p_identifier text,
  p_purpose    text,
  p_code_hash  text
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_row otp_challenges;
begin
  select * into v_row
    from otp_challenges
   where identifier = p_identifier
     and purpose    = p_purpose
     and consumed_at is null
     and expires_at > now()
   order by created_at desc
   limit 1
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_active');
  end if;

  if v_row.attempts >= v_row.max_attempts then
    update otp_challenges set consumed_at = now() where id = v_row.id;
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
  end if;

  if v_row.code_hash = p_code_hash then
    update otp_challenges set consumed_at = now() where id = v_row.id;
    return jsonb_build_object('ok', true, 'user_id', v_row.user_id);
  end if;

  update otp_challenges
     set attempts    = attempts + 1,
         consumed_at = case when attempts + 1 >= max_attempts then now() else null end
   where id = v_row.id;

  return jsonb_build_object(
    'ok', false,
    'reason', 'mismatch',
    'remaining', greatest(v_row.max_attempts - (v_row.attempts + 1), 0)
  );
end
$$;

-- Purge consumed/expired codes. Fold into app.sweep() housekeeping.
create or replace function app.sweep_otp() returns int
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_n int;
begin
  delete from otp_challenges
   where (consumed_at is not null and consumed_at < now() - interval '1 day')
      or expires_at < now() - interval '1 day';
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- service_role only, like every other app.* function.
revoke all on function app.create_otp_challenge(text, text, text, text, int, int) from public;
revoke all on function app.verify_otp_challenge(text, text, text) from public;
revoke all on function app.sweep_otp() from public;
grant execute on function app.create_otp_challenge(text, text, text, text, int, int) to service_role;
grant execute on function app.verify_otp_challenge(text, text, text) to service_role;
grant execute on function app.sweep_otp() to service_role;
