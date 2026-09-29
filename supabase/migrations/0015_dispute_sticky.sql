-- ============================================================================
-- 0015 — disputes cannot rewrite a settled outcome (security review #4).
--
-- 0002's app.apply_dispute set orders.status straight from the dispute status,
-- whatever the order already was. So:
--
--   * a late or retried `created`/`under_review` for a LOST dispute moved
--     charged_back back to disputed, and a `won`/`closed` then made it paid
--   * any dispute event on a REFUNDED order left it paid or disputed
--   * the webhook ledger dedupes on X-Razorpay-Event-Id, which the HMAC does
--     not cover, so one signed body re-posted under a fresh id replayed an old
--     `payment.dispute.won` onto a charged-back order
--
-- The rules now, per order:
--
--   * charged_back is terminal. Nothing a dispute says moves it.
--   * lost -> charged_back from any post-paid state (a refunded order can
--     still be charged back; that is a second loss and the books must say so)
--   * an open dispute (created / under_review / action_required / …) moves
--     paid -> disputed and leaves disputed, refunded and charged_back alone
--   * won / closed moves disputed -> paid, and only once NO other dispute on
--     the order is still open. They never touch refunded or charged_back.
--
-- And per dispute row: once won/lost/closed, a stale open status cannot
-- overwrite it. Razorpay treats those three as final.
--
-- Separately, the ledger gets a unique hash of the signed body, so the same
-- signed bytes are accepted once whatever event-id header rides along.
-- ============================================================================

create or replace function app.dispute_is_final(p_status text) returns boolean
  language sql immutable set search_path = app, public
as $$ select p_status in ('won', 'lost', 'closed') $$;

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
  v_order_id  uuid;
  v_current   order_status;
  v_new       order_status;
  v_prev      text;
  v_effective text;
  v_open      int;
begin
  select order_id into v_order_id from payment_attempts
   where razorpay_payment_id = p_rzp_payment_id;
  if v_order_id is null then
    raise exception 'no attempt for payment %', p_rzp_payment_id using errcode = '22023';
  end if;

  -- Serialise every dispute event for this order behind one row lock, so two
  -- disputes resolving at once cannot both read "no other open dispute".
  select status into v_current from orders where id = v_order_id for update;

  select status into v_prev from disputes where razorpay_dispute_id = p_rzp_dispute_id;

  -- A final dispute status never regresses to an open one.
  v_effective := case
                   when v_prev is not null and app.dispute_is_final(v_prev)
                        and not app.dispute_is_final(p_status) then v_prev
                   else p_status
                 end;

  insert into disputes (order_id, razorpay_dispute_id, status, amount_paise, respond_by)
       values (v_order_id, p_rzp_dispute_id, v_effective, p_amount_paise, p_respond_by)
  on conflict (razorpay_dispute_id) do update
     set status     = excluded.status,
         respond_by = coalesce(excluded.respond_by, disputes.respond_by);

  select count(*) into v_open from disputes
   where order_id = v_order_id and not app.dispute_is_final(status);

  v_new := case
             when v_current = 'charged_back'                     then v_current
             when v_effective = 'lost'                           then 'charged_back'::order_status
             when v_current = 'refunded'                         then v_current
             when not app.dispute_is_final(v_effective)          then
               case when v_current = 'paid' then 'disputed'::order_status else v_current end
             -- won / closed
             when v_current = 'disputed' and v_open = 0          then 'paid'::order_status
             else v_current
           end;

  if v_new is distinct from v_current then
    update orders set status = v_new where id = v_order_id;
  end if;

  return jsonb_build_object(
    'order_id', v_order_id,
    'status', v_new,
    'dispute_status', v_effective,
    'ignored_stale', v_effective is distinct from p_status
  );
end
$$;

revoke all on function app.apply_dispute(text, text, text, bigint, timestamptz) from public;
grant execute on function app.apply_dispute(text, text, text, bigint, timestamptz) to service_role;
revoke all on function app.dispute_is_final(text) from public;
grant execute on function app.dispute_is_final(text) to service_role;

-- ---------------------------------------------------------------------------
-- Webhook replay: one row per signed body.
-- ---------------------------------------------------------------------------
alter table razorpay_webhook_events add column if not exists body_sha256 text;
create unique index if not exists webhook_body_sha256_uidx
  on razorpay_webhook_events (body_sha256) where body_sha256 is not null;
