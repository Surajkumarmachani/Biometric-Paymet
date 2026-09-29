-- ============================================================================
-- 0018 — a full refund must not erase what was captured.
--
-- After a full refund Razorpay reports the payment as `refunded`. Any later
-- apply_payment_event for it — the customer's /api/pay/confirm, a webhook
-- redelivery, the reconciler — recomputed amount_captured_paise from
-- `captured` attempts only, got 0, and wrote it. The order then stayed `paid`
-- (never demoted) while app.apply_refund could no longer move it to
-- `refunded`, because its "captured > 0" test failed: the books showed a paid
-- order that had captured nothing.
--
-- Now a refunded attempt counts as captured, and the captured total never
-- decreases. Otherwise identical to 0010's definition.
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

  -- 'refunded' is a payment that WAS captured (Razorpay flips a fully
  -- refunded payment's status). Counting only 'captured' made a re-read after
  -- a full refund recompute the captured total as 0 (0018).
  select count(*) filter (where status in ('captured', 'refunded')) > 0,
         count(*) filter (where status in ('created', 'authorized')),
         coalesce(sum(amount_paise) filter (where status in ('captured', 'refunded')), 0)
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
         -- Money captured stays captured; refunds are tracked separately.
         amount_captured_paise = greatest(v_order.amount_captured_paise, v_captured_sum),
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
    'amount_captured_paise', greatest(v_order.amount_captured_paise, v_captured_sum)
  );
end
$$;
