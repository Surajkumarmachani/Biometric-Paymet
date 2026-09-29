-- ============================================================================
-- 0017 — managers refund (and decline refund requests) for their OWN store.
--
-- Until now requireStaff('manager') checked the role only, so a manager at
-- store X could refund any store's order, or a web order. The rule now:
--
--   * admin   — any order, including web orders (no store)
--   * manager — orders whose store_id is the manager's store
--   * anyone else, or an inactive staff row — never
--
-- It lives in the functions that admit the action rather than in the routes,
-- so no caller can forget it. Viewing is unchanged: managers can still look
-- up any order; they just cannot move money on another store's.
-- ============================================================================

create or replace function app.staff_may_refund(p_staff_id text, p_order_store uuid)
  returns boolean
  language sql stable security definer set search_path = app, public
as $$
  select exists (
    select 1 from staff s
     where s.clerk_id = p_staff_id
       and s.active
       and (s.role = 'admin'
            or (s.role = 'manager' and p_order_store is not null and s.store_id = p_order_store))
  )
$$;

revoke all on function app.staff_may_refund(text, uuid) from public;
grant execute on function app.staff_may_refund(text, uuid) to service_role;

-- reserve_refund (0016) + the store check.
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

  if not app.staff_may_refund(p_staff_id, v_order.store_id) then
    raise exception 'not your store: managers refund their own store''s orders'
      using errcode = '42501';
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

-- decline_refund_request (0013) + the store check. 'not_yours' is reported
-- like 'not_open' — a manager learns nothing about another store's queue.
create or replace function app.decline_refund_request(
  p_request_id uuid,
  p_staff_id   text,
  p_note       text default null
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_row refund_requests;
begin
  update refund_requests r
     set status        = 'declined',
         decided_by    = p_staff_id,
         decided_at    = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
    from orders o
   where r.id       = p_request_id
     and r.status   = 'pending'
     and o.id       = r.order_id
     and app.staff_may_refund(p_staff_id, o.store_id)
  returning r.* into v_row;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_open');
  end if;

  return jsonb_build_object(
    'ok', true, 'request_id', v_row.id, 'order_id', v_row.order_id, 'status', v_row.status
  );
end
$$;
