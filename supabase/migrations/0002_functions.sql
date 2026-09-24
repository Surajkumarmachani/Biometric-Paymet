-- ============================================================================
-- 0002_functions.sql — the invariants, in the database
--
-- Everything that must be atomic or must not be bypassable lives here rather
-- than in application code:
--
--   * price is computed from product_prices, never accepted from a caller
--   * the challenge amount is INSERT..SELECTed from orders
--   * challenge consumption is one statement, so check-then-use cannot race
--   * order state transitions enforce the §7 invariants (paid is never demoted;
--     abandoned is not terminal)
--   * fulfilment is exactly-once by construction (fulfilled_at + a returned flag)
--
-- A future developer who wires a new route cannot accidentally skip these,
-- because there is no other way to move an order forward.
-- ============================================================================

-- ============================================================================
-- Rate limiting (fixed window). Cheap, atomic, good enough for abuse control.
-- Returns TRUE when the call is allowed.
-- ============================================================================

create or replace function app.rate_limit_hit(
  p_bucket text,
  p_limit  int,
  p_window interval
) returns boolean
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_count int;
begin
  insert into rate_limits (bucket, count, window_start)
       values (p_bucket, 1, now())
  on conflict (bucket) do update
     set count        = case when rate_limits.window_start < now() - p_window
                            then 1 else rate_limits.count + 1 end,
         window_start = case when rate_limits.window_start < now() - p_window
                            then now() else rate_limits.window_start end
  returning count into v_count;

  return v_count <= p_limit;
end
$$;

-- ============================================================================
-- Order creation. Prices server-side. THE root of trust for money.
--
-- p_lines: [{"sku": "...", "qty": 2}, ...]   -- no money accepted, by design
-- Idempotent on p_idempotency_key: a retry returns the existing order.
-- ============================================================================

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

-- ============================================================================
-- QR claim. Idempotent so a page refresh does not dead-end the customer,
-- but still single-winner across two different customers.
-- ============================================================================

create or replace function app.claim_order(
  p_claim_token_hash text,
  p_user_id          text
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_order orders;
begin
  update orders
     set status     = case when status = 'draft' then 'claimed' else status end,
         claimed_at = coalesce(claimed_at, now()),
         user_id    = p_user_id
   where claim_token_hash = p_claim_token_hash
     and claim_token_expires_at > now()
     -- 'draft' => first claim. Already-'claimed' by the SAME user => refresh, allow.
     -- Any other status, or a different user => zero rows, caller gets 409.
     and (status = 'draft' or (status = 'claimed' and user_id = p_user_id))
  returning * into v_order;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  return jsonb_build_object(
    'claimed',      true,
    'order_id',     v_order.id,
    'amount_paise', v_order.amount_paise,
    'currency',     v_order.currency,
    'status',       v_order.status,
    'line_items',   v_order.line_items
  );
end
$$;

-- ============================================================================
-- Payment challenge (Option B). The amount is SELECTed from orders — there is
-- no parameter for it, so a caller cannot inject one.
-- ============================================================================

create or replace function app.create_payment_challenge(
  p_challenge   text,
  p_user_id     text,
  p_order_id    uuid,
  p_ttl_seconds int default 180   -- 3x the 60s ceremony timeout, deliberately
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_row payment_challenges;
begin
  insert into payment_challenges (
    challenge, user_id, order_id, amount_paise, currency, expires_at
  )
  select p_challenge, o.user_id, o.id, o.amount_paise, o.currency,
         now() + make_interval(secs => p_ttl_seconds)
    from orders o
   where o.id = p_order_id
     and o.user_id = p_user_id
     and o.status in ('draft', 'claimed', 'payment_failed')
  returning * into v_row;

  if not found then
    -- Not the caller's order, or not in a payable state. Do not fall through.
    raise exception 'order not payable by this user' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'challenge',    v_row.challenge,
    'order_id',     v_row.order_id,
    'amount_paise', v_row.amount_paise,
    'currency',     v_row.currency,
    'expires_at',   v_row.expires_at
  );
end
$$;

-- Atomic single-use consumption. One statement: the second concurrent caller
-- blocks, re-evaluates the predicate, and updates zero rows.
--
-- MUST be called in its own committed transaction, BEFORE signature
-- verification, so a failed verification still burns the challenge.
create or replace function app.consume_payment_challenge(
  p_challenge text
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_row payment_challenges;
begin
  update payment_challenges
     set consumed_at = now()
   where challenge = p_challenge
     and consumed_at is null
     and expires_at > now()
  returning * into v_row;

  if not found then
    return jsonb_build_object('consumed', false);
  end if;

  return jsonb_build_object(
    'consumed',     true,
    'challenge',    v_row.challenge,      -- required: expectedChallenge
    'user_id',      v_row.user_id,
    'order_id',     v_row.order_id,
    'amount_paise', v_row.amount_paise,
    'currency',     v_row.currency
  );
end
$$;

-- ============================================================================
-- Record the authorization and lock the amount.
-- UNIQUE (kind, ref) is the single-use guarantee for Option A.
-- ============================================================================

create or replace function app.record_authorization(
  p_order_id      uuid,
  p_kind          auth_kind,
  p_ref           text,
  p_user_id       text,
  p_amount_paise  bigint,
  p_credential_id text default null
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_order orders;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then
    raise exception 'unknown order' using errcode = '22023';
  end if;
  if v_order.user_id is distinct from p_user_id then
    raise exception 'order not owned by this user' using errcode = '42501';
  end if;

  -- The authorized amount must match the order. If they diverge, something
  -- upstream re-priced between options and verify: refuse.
  if v_order.amount_paise <> p_amount_paise then
    raise exception 'authorized amount % does not match order amount %',
      p_amount_paise, v_order.amount_paise using errcode = '22023';
  end if;

  if v_order.status not in ('draft', 'claimed', 'payment_failed', 'intent_verified') then
    raise exception 'order not in an authorizable state: %', v_order.status
      using errcode = '22023';
  end if;

  begin
    insert into payment_authorizations (
      order_id, kind, ref, credential_id, amount_paise, user_id
    ) values (
      p_order_id, p_kind, p_ref, p_credential_id, p_amount_paise, p_user_id
    );
  exception when unique_violation then
    -- Replayed reverification_id / challenge. This is the Option A guarantee.
    raise exception 'authorization reference already used' using errcode = '23505';
  end;

  update orders set status = 'intent_verified'
   where id = p_order_id and status <> 'intent_verified';

  return jsonb_build_object(
    'order_id',     p_order_id,
    'amount_paise', v_order.amount_paise,
    'currency',     v_order.currency
  );
end
$$;

-- ============================================================================
-- Attach the Razorpay order, reuse-safe.
-- Returns the EFFECTIVE razorpay_order_id: if one already exists we hand it
-- back instead of overwriting, which is what prevents orphaned orders on retry.
-- ============================================================================

create or replace function app.attach_razorpay_order(
  p_order_id      uuid,
  p_rzp_order_id  text
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_order orders;
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then
    raise exception 'unknown order' using errcode = '22023';
  end if;

  if v_order.razorpay_order_id is not null then
    -- Already attached: reuse. Also (re)open the payment window for a retry.
    update orders
       set status         = case when status in ('intent_verified', 'payment_failed')
                                 then 'awaiting_payment' else status end,
           awaiting_since = coalesce(awaiting_since, now()),
           next_poll_at   = least(coalesce(next_poll_at, now() + interval '10 seconds'),
                                  now() + interval '10 seconds'),
           poll_attempts  = 0
     where id = p_order_id;

    return jsonb_build_object(
      'razorpay_order_id', v_order.razorpay_order_id,
      'created',           false,
      'amount_paise',      v_order.amount_paise
    );
  end if;

  update orders
     set razorpay_order_id = p_rzp_order_id,
         status            = 'awaiting_payment',
         awaiting_since    = now(),
         next_poll_at      = now() + interval '10 seconds',
         poll_attempts     = 0
   where id = p_order_id;

  return jsonb_build_object(
    'razorpay_order_id', p_rzp_order_id,
    'created',           true,
    'amount_paise',      v_order.amount_paise
  );
end
$$;

-- ============================================================================
-- apply_payment_event — the state-convergent core.
--
-- Called by BOTH the webhook drain and the reconciler, always with truth
-- re-read from GET /v1/payments/:id rather than a webhook payload's stale
-- `status` field. That is what makes out-of-order delivery harmless.
--
-- Returns fulfil_now = true exactly once per order, ever.
-- ============================================================================

create or replace function app.apply_payment_event(
  p_rzp_order_id    text,
  p_rzp_payment_id  text,
  p_status          text,     -- created|authorized|captured|failed|refunded
  p_amount_paise    bigint,
  p_currency        text,
  p_method          text  default null,
  p_error           jsonb default '{}'::jsonb,
  p_acquirer        jsonb default '{}'::jsonb,
  p_fee_paise       bigint default null,
  p_tax_paise       bigint default null
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_order        orders;
  v_prev         order_status;
  v_new          order_status;
  v_has_captured boolean;
  v_open_attempts int;
  v_captured_sum bigint;
  v_fulfil       boolean := false;
  v_late         boolean := false;
  v_receipt      text;
begin
  select * into v_order from orders where razorpay_order_id = p_rzp_order_id for update;
  if not found then
    raise exception 'no order for razorpay_order_id %', p_rzp_order_id
      using errcode = '22023';
  end if;
  v_prev := v_order.status;

  -- Guard: a captured payment must match the order exactly. partial_payment is
  -- off, so any divergence means tampering or a mis-created Razorpay order.
  if p_status = 'captured'
     and (p_amount_paise <> v_order.amount_paise or p_currency <> v_order.currency) then
    raise exception 'captured amount/currency (% %) does not match order (% %)',
      p_amount_paise, p_currency, v_order.amount_paise, v_order.currency
      using errcode = '22023';
  end if;

  insert into payment_attempts (
    order_id, razorpay_payment_id, method, status, amount_paise,
    error_code, error_description, error_reason, acquirer_data
  ) values (
    v_order.id, p_rzp_payment_id, p_method, p_status, p_amount_paise,
    nullif(p_error ->> 'code', ''), nullif(p_error ->> 'description', ''),
    nullif(p_error ->> 'reason', ''), p_acquirer
  )
  on conflict (razorpay_payment_id) do update
     set status        = excluded.status,
         method        = coalesce(excluded.method, payment_attempts.method),
         amount_paise  = excluded.amount_paise,
         error_code    = excluded.error_code,
         error_description = excluded.error_description,
         error_reason  = excluded.error_reason,
         acquirer_data = excluded.acquirer_data;

  select count(*) filter (where status = 'captured') > 0,
         count(*) filter (where status in ('created', 'authorized')),
         coalesce(sum(amount_paise) filter (where status = 'captured'), 0)
    into v_has_captured, v_open_attempts, v_captured_sum
    from payment_attempts
   where order_id = v_order.id;

  -- ---- §7 invariants ----
  if v_prev in ('disputed', 'charged_back', 'refunded') then
    v_new := v_prev;                             -- post-paid states are sticky
  elsif v_has_captured then
    v_new := 'paid';                             -- capture wins over any failure
    if v_prev = 'abandoned' then
      v_late := true;                            -- late authorisation: alert
    end if;
  elsif v_prev = 'paid' then
    v_new := 'paid';                             -- invariant 1: never demote paid
  elsif v_open_attempts > 0 then
    v_new := 'awaiting_payment';
  elsif v_prev in ('awaiting_payment', 'payment_failed', 'abandoned') then
    v_new := 'payment_failed';
  else
    v_new := v_prev;
  end if;

  -- Exactly-once fulfilment: fulfilled_at is the latch.
  if v_new = 'paid' and v_order.fulfilled_at is null then
    v_fulfil  := true;
    v_receipt := coalesce(v_order.receipt_no,
                          'RL-' || to_char(now(), 'YYYY') || '-' ||
                          lpad(nextval('receipt_no_seq')::text, 6, '0'));
  end if;

  update orders
     set status                = v_new,
         amount_captured_paise = v_captured_sum,
         fee_paise             = coalesce(p_fee_paise, fee_paise),
         tax_paise             = coalesce(p_tax_paise, tax_paise),
         receipt_no            = coalesce(receipt_no, v_receipt),
         fulfilled_at          = case when v_fulfil then now() else fulfilled_at end,
         -- keep polling a paid order? no. keep polling abandoned for late auth.
         next_poll_at          = case
                                   when v_new = 'paid' then null
                                   when v_new = 'payment_failed' then null
                                   else next_poll_at
                                 end,
         awaiting_since        = case when v_new = 'paid' then awaiting_since
                                      else awaiting_since end
   where id = v_order.id;

  return jsonb_build_object(
    'order_id',           v_order.id,
    'previous_status',    v_prev,
    'status',             v_new,
    'fulfil_now',         v_fulfil,
    'late_authorisation', v_late,
    'receipt_no',         coalesce(v_order.receipt_no, v_receipt),
    'amount_captured_paise', v_captured_sum
  );
end
$$;

-- ============================================================================
-- Refunds and disputes
-- ============================================================================

create or replace function app.apply_refund(
  p_rzp_payment_id text,
  p_rzp_refund_id  text,
  p_amount_paise   bigint,
  p_status         text
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_order_id uuid;
  v_order    orders;
  v_total    bigint;
begin
  select order_id into v_order_id from payment_attempts
   where razorpay_payment_id = p_rzp_payment_id;
  if v_order_id is null then
    raise exception 'no attempt for payment %', p_rzp_payment_id using errcode = '22023';
  end if;

  insert into refunds (order_id, razorpay_refund_id, amount_paise, status)
       values (v_order_id, p_rzp_refund_id, p_amount_paise, p_status)
  on conflict (razorpay_refund_id) do update set status = excluded.status;

  select * into v_order from orders where id = v_order_id for update;

  select coalesce(sum(amount_paise), 0) into v_total
    from refunds where order_id = v_order_id and status = 'processed';

  update orders
     set amount_refunded_paise = v_total,
         -- Partial refunds do NOT change status (§7 invariant 4).
         status = case when v_total >= v_order.amount_captured_paise
                        and v_order.amount_captured_paise > 0
                       then 'refunded' else v_order.status end
   where id = v_order_id;

  return jsonb_build_object(
    'order_id', v_order_id,
    'amount_refunded_paise', v_total,
    'fully_refunded', v_total >= v_order.amount_captured_paise
                      and v_order.amount_captured_paise > 0
  );
end
$$;

create or replace function app.apply_dispute(
  p_rzp_payment_id text,
  p_rzp_dispute_id text,
  p_status         text,
  p_amount_paise   bigint      default null,
  p_respond_by     timestamptz default null
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_order_id uuid;
  v_new      order_status;
begin
  select order_id into v_order_id from payment_attempts
   where razorpay_payment_id = p_rzp_payment_id;
  if v_order_id is null then
    raise exception 'no attempt for payment %', p_rzp_payment_id using errcode = '22023';
  end if;

  insert into disputes (order_id, razorpay_dispute_id, status, amount_paise, respond_by)
       values (v_order_id, p_rzp_dispute_id, p_status, p_amount_paise, p_respond_by)
  on conflict (razorpay_dispute_id) do update
     set status = excluded.status, respond_by = excluded.respond_by;

  v_new := case p_status
             when 'lost' then 'charged_back'::order_status
             when 'won'  then 'paid'::order_status
             when 'closed' then 'paid'::order_status
             else 'disputed'::order_status
           end;

  update orders set status = v_new where id = v_order_id;

  return jsonb_build_object('order_id', v_order_id, 'status', v_new);
end
$$;

-- ============================================================================
-- Reconciler support.
--
-- Backoff: 10s, 20s, 40s, 60s, 120s, then every 60s to the 15-minute wall,
-- after which the order is abandoned but STILL polled hourly for 24h because
-- UPI late authorisation is routine (§7 invariant 2).
-- ============================================================================

create or replace function app.next_poll_delay(p_attempts int) returns interval
  language sql immutable
as $$
  select case p_attempts
           when 0 then interval '10 seconds'
           when 1 then interval '20 seconds'
           when 2 then interval '40 seconds'
           when 3 then interval '60 seconds'
           when 4 then interval '120 seconds'
           else        interval '60 seconds'
         end
$$;

create or replace function app.claim_due_orders(p_limit int default 50)
  returns table (
    order_id          uuid,
    razorpay_order_id text,
    status            order_status,
    poll_attempts     int,
    awaiting_since    timestamptz
  )
  language plpgsql security definer set search_path = app, public
as $$
begin
  return query
  with due as (
    select o.id
      from orders o
     where o.razorpay_order_id is not null
       and o.next_poll_at is not null
       and o.next_poll_at <= now()
       and o.status in ('awaiting_payment', 'abandoned')
     order by o.next_poll_at
     limit p_limit
     for update skip locked
  )
  update orders o
     set poll_attempts = o.poll_attempts + 1,
         -- past the 15-minute wall an awaiting order becomes abandoned, but we
         -- keep an hourly heartbeat for 24h to catch a late capture.
         status = case
                    when o.status = 'awaiting_payment'
                     and o.awaiting_since < now() - interval '15 minutes'
                    then 'abandoned'::order_status
                    else o.status
                  end,
         next_poll_at = case
                          when o.awaiting_since < now() - interval '24 hours'
                            then null                      -- give up for good
                          when o.awaiting_since < now() - interval '15 minutes'
                            then now() + interval '1 hour' -- late-auth heartbeat
                          else now() + app.next_poll_delay(o.poll_attempts)
                        end
    from due
   where o.id = due.id
  returning o.id, o.razorpay_order_id, o.status, o.poll_attempts, o.awaiting_since;
end
$$;

-- ============================================================================
-- Webhook ledger drain support
-- ============================================================================

create or replace function app.claim_webhook_batch(p_limit int default 25)
  returns table (
    event_id   text,
    event_type text,
    payload    jsonb,
    attempts   int
  )
  language plpgsql security definer set search_path = app, public
as $$
begin
  return query
  with due as (
    select e.event_id
      from razorpay_webhook_events e
     where e.status in ('pending', 'error')
       and e.next_attempt_at <= now()
     order by e.razorpay_created_at
     limit p_limit
     for update skip locked
  )
  update razorpay_webhook_events e
     set attempts        = e.attempts + 1,
         -- lease it out so a concurrent drain cannot pick up the same row
         next_attempt_at = now() + interval '2 minutes'
    from due
   where e.event_id = due.event_id
  returning e.event_id, e.event_type, e.payload, e.attempts;
end
$$;

create or replace function app.finish_webhook(
  p_event_id text,
  p_ok       boolean,
  p_error    text default null
) returns void
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_attempts int;
begin
  select attempts into v_attempts from razorpay_webhook_events where event_id = p_event_id;

  if p_ok then
    update razorpay_webhook_events
       set status = 'processed', processed_at = now(), last_error = null,
           next_attempt_at = now()
     where event_id = p_event_id;
  else
    update razorpay_webhook_events
       set status = case when v_attempts >= 8 then 'dead' else 'error' end,
           last_error = p_error,
           -- exponential backoff, capped
           next_attempt_at = now() + least(
             interval '1 minute' * power(2, greatest(v_attempts - 1, 0)),
             interval '6 hours')
     where event_id = p_event_id;
  end if;
end
$$;

-- ============================================================================
-- Housekeeping (schedule via pg_cron)
-- ============================================================================

create or replace function app.sweep() returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_challenges int;
  v_events     int;
  v_buckets    int;
begin
  delete from payment_challenges
   where expires_at < now() - interval '1 day';
  get diagnostics v_challenges = row_count;

  delete from razorpay_webhook_events
   where status = 'processed' and purge_after < now();
  get diagnostics v_events = row_count;

  delete from rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_buckets = row_count;

  return jsonb_build_object(
    'challenges_purged', v_challenges,
    'events_purged',     v_events,
    'buckets_purged',    v_buckets
  );
end
$$;

-- ============================================================================
-- Only service_role may execute these. anon/authenticated get nothing.
-- ============================================================================

revoke all on all functions in schema app from public;
revoke all on schema app from anon, authenticated;
grant usage on schema app to service_role;
grant execute on all functions in schema app to service_role;
