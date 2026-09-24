-- ============================================================================
-- 0009_credit_notes.sql — GST credit notes for refunds & chargebacks (S5 #2)
--
-- A refund or chargeback against an issued tax invoice legally requires a GST
-- CREDIT NOTE (its own consecutive series), not just an order status flip. This
-- records those credit notes, one per triggering event (razorpay refund id or
-- dispute id) so a redelivered webhook cannot double-issue.
--
-- The tax split is computed in the service layer (lib/credit-note.ts); this owns
-- the number and the durable record, like app.issue_invoice. service-role only.
-- Idempotent on 0001..0008.
-- ============================================================================

create table if not exists credit_notes (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id),
  invoice_no      text,                       -- original invoice referenced (if any)
  credit_note_no  text not null unique,
  ref             text not null unique,       -- refund id / dispute id (idempotency)
  reason          text not null,              -- refund | chargeback
  financial_year  text not null,
  issued_at       timestamptz not null default now(),
  seller          jsonb not null,
  buyer           jsonb not null,
  line_items      jsonb not null default '[]'::jsonb,
  taxable_paise   bigint not null,
  cgst_paise      bigint not null default 0,
  sgst_paise      bigint not null default 0,
  igst_paise      bigint not null default 0,
  total_paise     bigint not null,
  currency        text not null default 'INR'
);

create index if not exists credit_notes_order_idx on credit_notes (order_id);

alter table credit_notes enable row level security;
create policy own_credit_notes on credit_notes
  for select to authenticated
  using (exists (
    select 1 from orders o
     where o.id = credit_notes.order_id
       and o.user_id = (select auth.jwt() ->> 'sub')
  ));
grant select on credit_notes to authenticated;

create or replace function app.issue_credit_note(p_order_id uuid, p_ref text, p_payload jsonb)
  returns jsonb
  language plpgsql security definer set search_path = app, public
as $$
declare
  v_existing credit_notes;
  v_fy   text;
  v_no   bigint;
  v_cnno text;
  v_row  credit_notes;
begin
  -- Idempotent on the triggering event (refund/dispute id).
  select * into v_existing from credit_notes where ref = p_ref;
  if found then
    return to_jsonb(v_existing);
  end if;

  v_fy := case
            when extract(month from now()) >= 4
              then to_char(now(), 'YYYY') || '-' || to_char(now() + interval '1 year', 'YY')
            else to_char(now() - interval '1 year', 'YYYY') || '-' || to_char(now(), 'YY')
          end;

  -- Own series, namespaced from the invoice counter for the same FY.
  insert into invoice_counters (financial_year, last_no)
       values ('CN-' || v_fy, 1)
  on conflict (financial_year)
      do update set last_no = invoice_counters.last_no + 1
    returning last_no into v_no;

  v_cnno := 'RL-CN/' || v_fy || '/' || lpad(v_no::text, 6, '0');

  insert into credit_notes (
    order_id, invoice_no, credit_note_no, ref, reason, financial_year,
    seller, buyer, line_items,
    taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, currency
  ) values (
    p_order_id, p_payload ->> 'invoice_no', v_cnno, p_ref,
    coalesce(p_payload ->> 'reason', 'refund'), v_fy,
    p_payload -> 'seller', p_payload -> 'buyer',
    coalesce(p_payload -> 'line_items', '[]'::jsonb),
    (p_payload ->> 'taxable_paise')::bigint,
    coalesce((p_payload ->> 'cgst_paise')::bigint, 0),
    coalesce((p_payload ->> 'sgst_paise')::bigint, 0),
    coalesce((p_payload ->> 'igst_paise')::bigint, 0),
    (p_payload ->> 'total_paise')::bigint,
    coalesce(p_payload ->> 'currency', 'INR')
  )
  on conflict (ref) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from credit_notes where ref = p_ref;  -- lost a race
  end if;

  return to_jsonb(v_row);
end
$$;

revoke all on function app.issue_credit_note(uuid, text, jsonb) from public;
grant execute on function app.issue_credit_note(uuid, text, jsonb) to service_role;
