-- ============================================================================
-- 0008_refund_sticky.sql — a refund must not overwrite a chargeback
--
-- app.apply_payment_event already treats disputed/charged_back/refunded as
-- sticky post-paid states. app.apply_refund did not: a full refund recorded
-- against a `charged_back` order relabelled it `refunded`, hiding that the bank
-- had already clawed the money back — a different accounting reality.
--
-- Fix: a full refund still records the refunded amount, but it will NOT demote a
-- `charged_back` order. `disputed -> refunded` is left intact on purpose — a
-- merchant refunding to resolve a dispute is legitimate.
--
-- Redefines the function only; idempotent on 0001..0007.
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
         -- Partial refunds do NOT change status (§7 invariant 4). A full refund
         -- moves paid/disputed -> refunded, but NEVER demotes a chargeback.
         status = case when v_total >= v_order.amount_captured_paise
                        and v_order.amount_captured_paise > 0
                        and v_order.status <> 'charged_back'
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
