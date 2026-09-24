-- ============================================================================
-- 0013_refund_requests.sql — customer-initiated refund requests (S6)
--
-- Until now a refund could only START at the counter. /api/orders/[id]/refund
-- is manager-only, step-up gated and alerted on every call, which is right for
-- money moving outward — but it left the customer with no way to ASK. Their
-- only route was to walk back into the store, and nothing recorded the ask.
--
-- So this is the ask, not the refund: a durable, auditable row the customer
-- creates and staff decide on. It moves NO money. Approving one means a manager
-- runs the existing refund path, which then closes the request via
-- app.approve_open_refund_requests. Declining records a reason the customer can
-- read. The security posture of the refund itself is untouched.
--
-- One open request per order, enforced by a partial unique index rather than by
-- application logic, so two taps on a slow phone cannot open two.
--
-- Idempotent on 0001..0012.
-- ============================================================================

create table if not exists refund_requests (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id),
  user_id       text not null,                  -- Clerk subject of the requester
  amount_paise  bigint not null check (amount_paise > 0),
  reason        text not null,
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  decided_by    text,                           -- staff Clerk id, once decided
  decided_at    timestamptz,
  decision_note text,                           -- shown to the customer on a decline
  created_at    timestamptz not null default now()
);

create index if not exists refund_requests_order_idx
  on refund_requests (order_id, created_at desc);

-- The staff queue reads this: open requests, newest first.
create index if not exists refund_requests_open_idx
  on refund_requests (created_at desc) where status = 'pending';

-- The invariant. A partial unique index makes "at most one open request per
-- order" a property of the schema, so the double-submit race has no window.
create unique index if not exists refund_requests_one_open
  on refund_requests (order_id) where status = 'pending';

alter table refund_requests enable row level security;

-- Two permissive SELECT policies, OR-ed: the customer reads their own requests,
-- staff read their store's. Same shape as the pair on `orders` (0001 + 0005).
-- No write policy — rows are only ever created by app.request_refund.
drop policy if exists own_refund_requests on refund_requests;
create policy own_refund_requests on refund_requests
  for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

drop policy if exists staff_store_refund_requests on refund_requests;
create policy staff_store_refund_requests on refund_requests
  for select to authenticated
  using (exists (
    select 1 from orders o
     where o.id = refund_requests.order_id
       and o.store_id is not null
       and public.is_staff_for_store(o.store_id)
  ));

grant select on refund_requests to authenticated;

-- ============================================================================
-- How much is still refundable on an order.
--
-- Committed = pending + processed, NOT orders.amount_refunded_paise — that
-- column deliberately sums only `processed` refunds (money actually returned,
-- see 0008), so using it as the ceiling would let a second full refund through
-- while the first is still pending. The refund route already applies this rule
-- inline; this is the same rule in one place the request path can also trust.
-- ============================================================================

create or replace function app.refundable_paise(p_order_id uuid)
  returns bigint
  language sql security definer set search_path = app, public stable
as $$
  select greatest(
    0,
    coalesce((select o.amount_captured_paise from orders o where o.id = p_order_id), 0)
    - coalesce((select sum(r.amount_paise)
                  from refunds r
                 where r.order_id = p_order_id
                   and r.status in ('pending', 'processed')), 0)
  );
$$;

-- ============================================================================
-- Open a request.
--
-- Returns an outcome object rather than raising for the business outcomes (same
-- idiom as app.claim_order): the caller maps `reason` onto an HTTP code, and
-- the customer-facing copy lives in one place in the route instead of being
-- reverse-engineered from a SQLSTATE.
-- ============================================================================

create or replace function app.request_refund(
  p_order_id     uuid,
  p_user_id      text,
  p_reason       text,
  p_amount_paise bigint default null   -- null => everything still refundable
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_order      orders;
  v_refundable bigint;
  v_amount     bigint;
  v_row        refund_requests;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason required' using errcode = '22023';
  end if;

  select * into v_order from orders where id = p_order_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Ownership is checked here as well as in the route: this function is the
  -- only writer, so the rule belongs where it cannot be skipped.
  if v_order.user_id is distinct from p_user_id then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;

  -- Only a captured payment can be asked back. 'refunded' is already done, and
  -- 'charged_back' is the bank's money to return, not ours.
  if v_order.status <> 'paid' then
    return jsonb_build_object(
      'ok', false, 'reason', 'not_refundable', 'status', v_order.status
    );
  end if;

  v_refundable := app.refundable_paise(p_order_id);
  if v_refundable <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing_left');
  end if;

  v_amount := coalesce(p_amount_paise, v_refundable);
  if v_amount <= 0 or v_amount > v_refundable then
    return jsonb_build_object(
      'ok', false, 'reason', 'amount_out_of_range', 'refundable_paise', v_refundable
    );
  end if;

  begin
    insert into refund_requests (order_id, user_id, amount_paise, reason)
    values (p_order_id, p_user_id, v_amount, btrim(p_reason))
    returning * into v_row;
  exception when unique_violation then
    -- refund_requests_one_open. Someone already has one open on this order.
    return jsonb_build_object('ok', false, 'reason', 'already_open');
  end;

  return jsonb_build_object(
    'ok',           true,
    'request_id',   v_row.id,
    'order_id',     v_row.order_id,
    'amount_paise', v_row.amount_paise,
    'reason',       v_row.reason,
    'status',       v_row.status,
    'created_at',   v_row.created_at
  );
end
$$;

-- ============================================================================
-- The customer changes their mind. Scoped to the requester, so one customer
-- cannot withdraw another's, and only an OPEN request can be withdrawn — a
-- decided one is history.
-- ============================================================================

create or replace function app.withdraw_refund_request(
  p_order_id uuid,
  p_user_id  text
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_row refund_requests;
begin
  update refund_requests
     set status = 'withdrawn', decided_at = now()
   where order_id = p_order_id
     and user_id  = p_user_id
     and status   = 'pending'
  returning * into v_row;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_open_request');
  end if;

  return jsonb_build_object('ok', true, 'request_id', v_row.id, 'status', v_row.status);
end
$$;

-- ============================================================================
-- Staff decision.
--
-- 'declined' is the only decision that ENDS here. Approving is not a status
-- flip — it is a refund, so it goes through the existing refund route and lands
-- back via app.approve_open_refund_requests below. Accepting 'approved' here
-- too would let a manager mark a request approved without any money moving,
-- which is exactly the lie the customer would then be shown.
-- ============================================================================

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
  update refund_requests
     set status        = 'declined',
         decided_by    = p_staff_id,
         decided_at    = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where id     = p_request_id
     and status = 'pending'
  returning * into v_row;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_open');
  end if;

  return jsonb_build_object(
    'ok', true, 'request_id', v_row.id, 'order_id', v_row.order_id, 'status', v_row.status
  );
end
$$;

-- ============================================================================
-- Close the ask once a refund has actually happened.
--
-- Called by the refund route after Razorpay accepts the refund. Deliberately
-- does NOT create a request when none exists: a staff-initiated refund at the
-- counter is not a customer request, and inventing one would corrupt the very
-- record this table exists to keep. Returns the number closed so the caller can
-- audit it.
-- ============================================================================

create or replace function app.approve_open_refund_requests(
  p_order_id uuid,
  p_staff_id text
) returns int
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_count int;
begin
  update refund_requests
     set status     = 'approved',
         decided_by = p_staff_id,
         decided_at = now()
   where order_id = p_order_id
     and status   = 'pending';

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- Service-role only, like every other app.* function (0002 revokes and grants
-- wholesale, but this file may be applied on its own).
revoke all on function app.refundable_paise(uuid) from public;
revoke all on function app.request_refund(uuid, text, text, bigint) from public;
revoke all on function app.withdraw_refund_request(uuid, text) from public;
revoke all on function app.decline_refund_request(uuid, text, text) from public;
revoke all on function app.approve_open_refund_requests(uuid, text) from public;
grant execute on all functions in schema app to service_role;
