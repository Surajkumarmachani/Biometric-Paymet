-- ============================================================================
-- 0006_invoices.sql — GST tax invoices (S5)
--
-- Turns a paid order into a formal, numbered GST invoice. The invoice number is
-- assigned atomically from a per-financial-year counter (Indian FY Apr–Mar), so
-- the series is consecutive as GST requires. One invoice per order, idempotent.
--
-- The tax breakup itself is computed in the service layer (lib/invoice.ts) in
-- integer paise and passed in as a payload — this function owns the NUMBER and
-- the durable record, not the arithmetic.
--
-- Correctness of GST treatment (rate, HSN, intra/inter-state) depends on the
-- seller config you supply; this is the mechanism, not tax advice.
--
-- Idempotent: safe to apply on top of 0001..0005.
-- ============================================================================

alter table products add column if not exists hsn text;  -- HSN/SAC per product

create table if not exists invoice_counters (
  financial_year text primary key,
  last_no         bigint not null default 0
);

create table if not exists invoices (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null unique references orders(id),
  invoice_no      text not null unique,
  financial_year  text not null,
  issued_at       timestamptz not null default now(),
  seller          jsonb not null,
  buyer           jsonb not null,
  place_of_supply text,
  line_items      jsonb not null,       -- per line: hsn, taxable, rate, cgst/sgst/igst
  taxable_paise   bigint not null,
  cgst_paise      bigint not null default 0,
  sgst_paise      bigint not null default 0,
  igst_paise      bigint not null default 0,
  total_paise     bigint not null,
  currency        text not null default 'INR'
);

alter table invoices enable row level security;
-- A customer may read their own invoice (defence in depth; server reads via
-- service role). No write policy — invoices are issued only by app.issue_invoice.
create policy own_invoices on invoices
  for select to authenticated
  using (exists (
    select 1 from orders o
     where o.id = invoices.order_id
       and o.user_id = (select auth.jwt() ->> 'sub')
  ));
grant select on invoices to authenticated;

create or replace function app.issue_invoice(p_order_id uuid, p_payload jsonb)
  returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_existing invoices;
  v_fy       text;
  v_no       bigint;
  v_invno    text;
  v_row      invoices;
begin
  -- Idempotent: one invoice per order, ever.
  select * into v_existing from invoices where order_id = p_order_id;
  if found then
    return to_jsonb(v_existing);
  end if;

  -- Indian financial year label, e.g. 2026-27 (Apr–Mar).
  v_fy := case
            when extract(month from now()) >= 4
              then to_char(now(), 'YYYY') || '-' || to_char(now() + interval '1 year', 'YY')
            else to_char(now() - interval '1 year', 'YYYY') || '-' || to_char(now(), 'YY')
          end;

  insert into invoice_counters (financial_year, last_no)
       values (v_fy, 1)
  on conflict (financial_year)
      do update set last_no = invoice_counters.last_no + 1
    returning last_no into v_no;

  v_invno := 'RL/' || v_fy || '/' || lpad(v_no::text, 6, '0');

  insert into invoices (
    order_id, invoice_no, financial_year, seller, buyer, place_of_supply,
    line_items, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, currency
  ) values (
    p_order_id, v_invno, v_fy,
    p_payload -> 'seller',
    p_payload -> 'buyer',
    p_payload ->> 'place_of_supply',
    coalesce(p_payload -> 'line_items', '[]'::jsonb),
    (p_payload ->> 'taxable_paise')::bigint,
    coalesce((p_payload ->> 'cgst_paise')::bigint, 0),
    coalesce((p_payload ->> 'sgst_paise')::bigint, 0),
    coalesce((p_payload ->> 'igst_paise')::bigint, 0),
    (p_payload ->> 'total_paise')::bigint,
    coalesce(p_payload ->> 'currency', 'INR')
  )
  on conflict (order_id) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- Lost a concurrent race; return whoever won.
    select * into v_row from invoices where order_id = p_order_id;
  end if;

  return to_jsonb(v_row);
end
$$;

revoke all on function app.issue_invoice(uuid, jsonb) from public;
grant execute on function app.issue_invoice(uuid, jsonb) to service_role;

-- Dev seed: jewellery HSN 7113 for the seeded products (no-op in prod).
update products set hsn = '7113'
 where hsn is null
   and id in (
     'aaaaaaaa-0000-0000-0000-000000000001',
     'aaaaaaaa-0000-0000-0000-000000000002',
     'aaaaaaaa-0000-0000-0000-000000000003',
     'aaaaaaaa-0000-0000-0000-000000000004',
     'aaaaaaaa-0000-0000-0000-000000000098',
     'aaaaaaaa-0000-0000-0000-000000000099'
   );
