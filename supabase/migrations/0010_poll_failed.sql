-- ============================================================================
-- 0010_poll_failed.sql — keep polling payment_failed for a late capture (S5 #3)
--
-- A UPI collect can confirm late at the bank even after an apparent failure
-- (the same shape as invariant 2, "abandoned is not terminal"). Previously a
-- payment_failed order had next_poll_at set to null and was excluded from the
-- reconciler, so a late capture with no webhook would be missed.
--
-- Fix: payment_failed keeps an hourly late-auth heartbeat, bounded to 24h after
-- awaiting_since (same window as abandoned), and the reconciler now claims it.
-- A retry still reopens awaiting_payment and takes over. A genuine late capture
-- flips payment_failed -> paid via the existing invariant.
--
-- Redefines two functions verbatim from 0002 with two targeted changes.
-- Idempotent on 0001..0009.
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
    if v_prev in ('abandoned', 'payment_failed') then
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
         -- paid stops polling; payment_failed keeps an hourly late-auth
         -- heartbeat bounded to 24h (a late UPI capture can still land);
         -- everything else keeps its schedule.
         next_poll_at          = case
                                   when v_new = 'paid' then null
                                   when v_new = 'payment_failed' then
                                     case when coalesce(v_order.awaiting_since, now())
                                               < now() - interval '24 hours'
                                          then null
                                          else now() + interval '1 hour'
                                     end
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
       -- payment_failed joins awaiting/abandoned so a late capture is still caught.
       and o.status in ('awaiting_payment', 'abandoned', 'payment_failed')
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
