-- ============================================================================
-- 0007_settlements.sql — settlement reconciliation (S5)
--
-- Knowing a payment was "captured" is not the same as knowing the money reached
-- your bank. Razorpay batches captures into settlements (minus fees + GST on
-- fees) and pays them out with a UTR. This records those settlements and, per
-- transaction, checks the settled gross against what we captured — flagging any
-- divergence rather than trusting it.
--
-- Reconciliation itself runs in the service layer (lib/settlement.ts) against
-- the Razorpay Settlements + recon APIs; these functions own the durable record
-- and the match check. service-role only. Idempotent on 0001..0006.
-- ============================================================================

create table if not exists settlements (
  razorpay_settlement_id text primary key,
  amount_paise bigint not null,
  fees_paise   bigint not null default 0,
  tax_paise    bigint not null default 0,
  status       text not null,
  utr          text,
  settled_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists settlement_txns (
  id                     uuid primary key default gen_random_uuid(),
  razorpay_settlement_id text references settlements(razorpay_settlement_id),
  razorpay_payment_id    text not null,
  order_id               uuid references orders(id),
  type                   text not null,            -- payment | refund | adjustment
  gross_paise            bigint not null,
  fee_paise              bigint not null default 0,
  tax_paise              bigint not null default 0,
  net_paise              bigint not null,
  reconciled             boolean not null default false,
  discrepancy            text,
  created_at             timestamptz not null default now(),
  unique (razorpay_settlement_id, razorpay_payment_id, type)
);

create index if not exists settlement_txns_order_idx on settlement_txns (order_id);
create index if not exists settlement_txns_unreconciled_idx on settlement_txns (reconciled) where not reconciled;

alter table settlements     enable row level security;  -- service-role only
alter table settlement_txns enable row level security;  -- service-role only

create or replace function app.record_settlement(
  p_id text, p_amount_paise bigint, p_fees_paise bigint, p_tax_paise bigint,
  p_status text, p_utr text default null, p_settled_at timestamptz default null
) returns void
  language plpgsql security definer set search_path = app, public
as $$
begin
  insert into settlements (razorpay_settlement_id, amount_paise, fees_paise, tax_paise, status, utr, settled_at)
       values (p_id, p_amount_paise, p_fees_paise, p_tax_paise, p_status, p_utr, p_settled_at)
  on conflict (razorpay_settlement_id) do update
     set amount_paise = excluded.amount_paise,
         fees_paise   = excluded.fees_paise,
         tax_paise    = excluded.tax_paise,
         status       = excluded.status,
         utr          = coalesce(excluded.utr, settlements.utr),
         settled_at   = coalesce(excluded.settled_at, settlements.settled_at),
         updated_at   = now();
end
$$;

-- Record one reconciliation row and CHECK it. For a payment, the settled gross
-- must equal what we captured in payment_attempts; anything else is flagged and
-- returned so the caller can alert. On a clean match the order is stamped with
-- its settlement id.
create or replace function app.record_settlement_txn(
  p_settlement_id text, p_payment_id text, p_type text,
  p_gross_paise bigint, p_fee_paise bigint, p_tax_paise bigint, p_net_paise bigint
) returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_order_id   uuid;
  v_captured   bigint;
  v_reconciled boolean := true;
  v_disc       text;
begin
  select order_id, amount_paise into v_order_id, v_captured
    from payment_attempts where razorpay_payment_id = p_payment_id;

  if p_type = 'payment' then
    if v_order_id is null then
      v_reconciled := false; v_disc := 'no matching payment_attempt';
    elsif v_captured is distinct from p_gross_paise then
      v_reconciled := false;
      v_disc := format('settled gross %s != captured %s', p_gross_paise, v_captured);
    end if;
  end if;

  insert into settlement_txns (
    razorpay_settlement_id, razorpay_payment_id, order_id, type,
    gross_paise, fee_paise, tax_paise, net_paise, reconciled, discrepancy
  ) values (
    p_settlement_id, p_payment_id, v_order_id, p_type,
    p_gross_paise, p_fee_paise, p_tax_paise, p_net_paise, v_reconciled, v_disc
  )
  on conflict (razorpay_settlement_id, razorpay_payment_id, type) do update
     set gross_paise = excluded.gross_paise,
         fee_paise   = excluded.fee_paise,
         tax_paise   = excluded.tax_paise,
         net_paise   = excluded.net_paise,
         order_id    = excluded.order_id,
         reconciled  = excluded.reconciled,
         discrepancy = excluded.discrepancy;

  if v_reconciled and v_order_id is not null and p_settlement_id is not null then
    update orders set settlement_id = p_settlement_id
     where id = v_order_id and settlement_id is null;
  end if;

  return jsonb_build_object('order_id', v_order_id, 'reconciled', v_reconciled, 'discrepancy', v_disc);
end
$$;

revoke all on function app.record_settlement(text, bigint, bigint, bigint, text, text, timestamptz) from public;
revoke all on function app.record_settlement_txn(text, text, text, bigint, bigint, bigint, bigint) from public;
grant execute on function app.record_settlement(text, bigint, bigint, bigint, text, text, timestamptz) to service_role;
grant execute on function app.record_settlement_txn(text, text, text, bigint, bigint, bigint, bigint) to service_role;
