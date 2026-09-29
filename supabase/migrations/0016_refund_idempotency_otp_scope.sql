-- ============================================================================
-- 0016 — security review #5, #7, #10 and the refund step-up/race findings.
--
--   * app.reserve_refund: the one place a staff refund is admitted. Locks the
--     order, requires `paid`, spends the step-up once, and returns what is
--     still refundable. The refund route calls it inside the same transaction
--     as the Razorpay call, so two managers refunding one order at once now
--     queue behind the row lock instead of both passing a stale ceiling.
--   * app.create_order: an idempotency key replays only for the caller who
--     created it. Before, anyone sending another user's key got that user's
--     order id, amount and Razorpay order back.
--   * OTP challenges are per user: sending a code no longer burns someone
--     else's, and verifying only ever matches the caller's own challenge.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Refunds
-- ---------------------------------------------------------------------------

-- One refund per step-up. payment_authorizations does this for payments via
-- UNIQUE (kind, ref); refunds had no equivalent, so one gesture inside Clerk's
-- window could approve refunds on several orders.
create table if not exists refund_gestures (
  reverification_id text primary key,
  order_id          uuid not null references orders(id),
  staff_id          text not null,
  used_at           timestamptz not null default now()
);
alter table refund_gestures enable row level security;
-- service-role only: RLS on, no policies, no grants.

create or replace function app.reserve_refund(
  p_order_id          uuid,
  p_reverification_id text,
  p_staff_id          text
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_order     orders;
  v_payment   text;
  v_committed bigint;
begin
  -- Held until the caller's transaction ends — i.e. across the Razorpay call.
  select * into v_order from orders where id = p_order_id for update;
  if not found then
    raise exception 'order not found' using errcode = '22023';
  end if;

  -- `paid` only (partial refunds keep an order `paid`). A charged_back order
  -- has already lost its money to the bank; refunding it pays twice. A
  -- disputed one may be about to. refunded has nothing left.
  if v_order.status <> 'paid' then
    raise exception 'order is %, only a paid order can be refunded', v_order.status
      using errcode = '42501';
  end if;

  select razorpay_payment_id into v_payment from payment_attempts
   where order_id = p_order_id and status = 'captured'
   limit 1;
  if v_payment is null then
    raise exception 'no captured payment on this order' using errcode = '42501';
  end if;

  -- Spend the gesture. A reuse raises 23505, which the route turns into a
  -- fresh step-up prompt.
  insert into refund_gestures (reverification_id, order_id, staff_id)
       values (p_reverification_id, p_order_id, p_staff_id);

  -- pending + processed: a refund Razorpay accepted but has not settled still
  -- counts against the ceiling (see the refund route for why).
  select coalesce(sum(amount_paise), 0) into v_committed from refunds
   where order_id = p_order_id and status in ('pending', 'processed');

  return jsonb_build_object(
    'razorpay_payment_id', v_payment,
    'captured_paise',      v_order.amount_captured_paise,
    'committed_paise',     v_committed,
    'remaining_paise',     greatest(v_order.amount_captured_paise - v_committed, 0)
  );
end
$$;

revoke all on function app.reserve_refund(uuid, text, text) from public;
grant execute on function app.reserve_refund(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Idempotency keys replay only for their owner.
--
-- The key stays globally unique — it doubles as the Razorpay `receipt` — but
-- a collision from a different caller is now an error, not a replay.
-- ---------------------------------------------------------------------------
create or replace function app.create_order(
  p_user_id          text,
  p_lines            jsonb,
  p_idempotency_key  text,
  p_store_id         uuid    default null,
  p_staff_id         text    default null,
  p_claim_token_hash text    default null,   -- sha256 hex; plaintext never reaches the DB
  p_claim_ttl_secs   int     default 900     -- 15 min: the customer must sign in first
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_existing   orders;
  v_items      jsonb;
  v_total      bigint;
  v_currency   text;
  v_order      orders;
  v_line_count int;
  v_currencies int;
begin
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'idempotency_key required' using errcode = '22023';
  end if;
  if length(p_idempotency_key) > 40 then
    -- Razorpay `receipt` is capped at 40 chars and we reuse this key as the receipt.
    raise exception 'idempotency_key too long for Razorpay receipt (max 40)'
      using errcode = '22023';
  end if;

  select * into v_existing from orders where idempotency_key = p_idempotency_key;
  if found then
    -- Replay only for the caller who created it (0016). The key is globally
    -- unique because it doubles as the Razorpay receipt, so a collision from
    -- anyone else is refused rather than handed their order back.
    if v_existing.user_id  is distinct from p_user_id
       or v_existing.staff_id is distinct from p_staff_id then
      raise exception 'idempotency_key already used by another caller'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'order_id',          v_existing.id,
      'amount_paise',      v_existing.amount_paise,
      'currency',          v_existing.currency,
      'status',            v_existing.status,
      'razorpay_order_id', v_existing.razorpay_order_id,
      'replayed',          true
    );
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'at least one line required' using errcode = '22023';
  end if;

  -- Price every line from the CURRENT price row. Missing sku, inactive product
  -- or absent current price all fail loudly rather than defaulting to zero.
  with req as (
    select (l ->> 'sku')::text                  as sku,
           coalesce((l ->> 'qty')::int, 0)      as qty
      from jsonb_array_elements(p_lines) l
  ),
  priced as (
    select r.sku,
           r.qty,
           p.id                     as product_id,
           p.name,
           pp.id                    as price_id,
           pp.amount_paise          as unit_paise,
           pp.currency,
           (pp.amount_paise * r.qty) as line_paise
      from req r
      join products p        on p.sku = r.sku and p.active
      join product_prices pp on pp.product_id = p.id and pp.valid_to is null
     where r.qty > 0
  )
  select jsonb_agg(jsonb_build_object(
           'sku',        sku,
           'name',       name,
           'qty',        qty,
           'product_id', product_id,
           'price_id',   price_id,
           'unit_paise', unit_paise,
           'line_paise', line_paise
         ) order by sku),
         sum(line_paise),
         min(currency),
         count(*),
         count(distinct currency)
    into v_items, v_total, v_currency, v_line_count, v_currencies
    from priced;

  -- Every requested line must have priced. A missing sku, an inactive product,
  -- an absent current price or qty < 1 all drop the row from `priced`, so a
  -- count mismatch is the single check that catches all of them. Never default
  -- a missing price to zero.
  if v_line_count is null or v_line_count <> jsonb_array_length(p_lines) then
    raise exception 'unknown sku, inactive product, no current price, or qty < 1'
      using errcode = '22023';
  end if;
  if v_currencies > 1 then
    raise exception 'mixed currencies in one order' using errcode = '22023';
  end if;

  insert into orders (
    user_id, status, amount_paise, currency, line_items,
    store_id, staff_id, idempotency_key,
    claim_token_hash, claim_token_expires_at
  ) values (
    p_user_id, 'draft', v_total, coalesce(v_currency, 'INR'), v_items,
    p_store_id, p_staff_id, p_idempotency_key,
    p_claim_token_hash,
    case when p_claim_token_hash is null
         then null else now() + make_interval(secs => p_claim_ttl_secs) end
  ) returning * into v_order;

  return jsonb_build_object(
    'order_id',     v_order.id,
    'amount_paise', v_order.amount_paise,
    'currency',     v_order.currency,
    'status',       v_order.status,
    'line_items',   v_order.line_items,
    'replayed',     false
  );
end
$$;

-- ---------------------------------------------------------------------------
-- OTP challenges are scoped to the user who asked for them.
-- ---------------------------------------------------------------------------
drop index if exists otp_active_idx;
create index if not exists otp_active_idx
  on otp_challenges (identifier, purpose, user_id)
  where consumed_at is null;

create or replace function app.create_otp_challenge(
  p_identifier   text,
  p_code_hash    text,
  p_user_id      text default null,
  p_purpose      text default 'verify',
  p_ttl_seconds  int  default 300,
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

  -- Supersede only THIS user's earlier code. Burning every active code for
  -- the identifier let anyone cancel someone else's by requesting their own.
  update otp_challenges
     set consumed_at = now()
   where identifier = p_identifier
     and purpose    = p_purpose
     and user_id is not distinct from p_user_id
     and consumed_at is null;

  insert into otp_challenges (
    identifier, purpose, code_hash, user_id, max_attempts, expires_at
  ) values (
    p_identifier, p_purpose, p_code_hash, p_user_id, p_max_attempts,
    now() + make_interval(secs => p_ttl_seconds)
  ) returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'expires_at', v_row.expires_at);
end
$$;

-- The 3-argument verify matched any user's challenge. Replace it outright so
-- nothing can keep calling the unscoped form.
drop function if exists app.verify_otp_challenge(text, text, text);

create or replace function app.verify_otp_challenge(
  p_identifier text,
  p_purpose    text,
  p_code_hash  text,
  p_user_id    text
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
     and user_id is not distinct from p_user_id
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

revoke all on function app.verify_otp_challenge(text, text, text, text) from public;
grant execute on function app.verify_otp_challenge(text, text, text, text) to service_role;
