-- ============================================================================
-- 0001_schema.sql — REGAL LAB biometric checkout
--
-- Written for CLERK, not Supabase Auth. Clerk subjects are strings
-- ('user_2ab...'), not uuids, so:
--   * every user_id column is `text`
--   * there is no FK to auth.users
--   * RLS policies compare against auth.jwt()->>'sub', NOT auth.uid()
--     (auth.uid() casts sub to uuid and raises 22P02 on a Clerk subject)
--
-- Money is integer paise everywhere. Never a float, never rupees.
-- ============================================================================

create extension if not exists pgcrypto;

create schema if not exists app;
comment on schema app is
  'Server-side invariants. Every function here is SECURITY DEFINER and owned by '
  'the migration role; application code reaches them only via service_role RPC.';

-- ============================================================================
-- People and places
-- ============================================================================

create table app_users (
  clerk_id             text primary key,
  email                text,
  razorpay_customer_id text unique,
  created_at           timestamptz not null default now()
);

create table stores (
  id     uuid primary key default gen_random_uuid(),
  name   text not null,
  mcc    text,                                   -- '5944' = jewellery, see rails.ts
  active boolean not null default true
);

create type staff_role as enum ('associate', 'manager', 'admin');

create table staff (
  clerk_id text primary key references app_users(clerk_id) on delete cascade,
  store_id uuid not null references stores(id),
  role     staff_role not null default 'associate',
  active   boolean not null default true
);

-- ============================================================================
-- Root of trust for price.
--
-- The client sends {sku, qty}. It never sends money. Everything downstream
-- that claims to be a "server-derived amount" traces back to product_prices.
-- ============================================================================

create table products (
  id     uuid primary key default gen_random_uuid(),
  sku    text not null unique,
  name   text not null,
  active boolean not null default true
);

create table product_prices (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id),
  amount_paise bigint not null check (amount_paise > 0),
  currency     text not null default 'INR',
  valid_from   timestamptz not null default now(),
  valid_to     timestamptz                        -- null = the current price
);

-- Exactly one current price per product. This is what makes pricing deterministic.
create unique index one_current_price_per_product
  on product_prices (product_id) where valid_to is null;

-- ============================================================================
-- Orders
-- ============================================================================

create type order_status as enum (
  'draft',            -- created; in-store not yet claimed, web not yet authorized
  'claimed',          -- in-store: bound to a customer via QR claim
  'intent_verified',  -- passkey / Clerk reverification succeeded, amount locked
  'awaiting_payment', -- Razorpay order exists; checkout open or retrying
  'payment_failed',   -- every attempt so far failed; customer may retry
  'paid',
  'abandoned',        -- reconciler gave up; NOT terminal (late authorisation)
  'disputed',
  'charged_back',
  'refunded'          -- fully refunded; partials stay 'paid' w/ amount_refunded > 0
);

create sequence receipt_no_seq start 1001;

create table orders (
  id           uuid primary key default gen_random_uuid(),
  user_id      text references app_users(clerk_id),   -- null until claimed (in-store)
  status       order_status not null default 'draft',

  amount_paise bigint not null check (amount_paise > 0),
  currency     text not null default 'INR',
  -- Snapshot: [{product_id, sku, name, qty, unit_paise, line_paise, price_id}]
  -- price_id records WHICH price row was used, so a later price change is auditable.
  line_items   jsonb not null,

  store_id     uuid references stores(id),             -- null for web
  staff_id     text references staff(clerk_id),
  receipt_no   text unique,                            -- issued once, on first paid

  -- in-store QR claim
  claim_token_hash       text unique,
  claim_token_expires_at timestamptz,
  claimed_at             timestamptz,

  -- Razorpay: ONE order, reused across retries. Minting a fresh one per retry
  -- orphans the previous order and makes a real payment invisible to the
  -- reconciler. See §11 of the architecture doc.
  idempotency_key   text not null unique,              -- also sent as `receipt`, <=40 chars
  razorpay_order_id text unique,

  -- money ledger
  amount_captured_paise bigint not null default 0,
  amount_refunded_paise bigint not null default 0,
  fee_paise             bigint,
  tax_paise             bigint,
  settlement_id         text,

  -- reconciler state
  awaiting_since timestamptz,
  next_poll_at   timestamptz,
  poll_attempts  int not null default 0,

  fulfilled_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint refund_within_capture
    check (amount_refunded_paise <= amount_captured_paise),
  constraint claim_token_pairing
    check ((claim_token_hash is null) = (claim_token_expires_at is null))
);

create index orders_open_idx  on orders (status)
  where status in ('awaiting_payment', 'payment_failed');
create index orders_poll_idx  on orders (next_poll_at)
  where status in ('awaiting_payment', 'abandoned');
create index orders_user_idx  on orders (user_id);

create or replace function app.touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger orders_touch before update on orders
  for each row execute function app.touch_updated_at();

-- ============================================================================
-- Payment attempts: ONE order, MANY attempts.
-- The double-fulfilment guard lives on razorpay_payment_id here, not on orders.
-- ============================================================================

create table payment_attempts (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id) on delete cascade,
  razorpay_payment_id text unique not null,
  method              text,                 -- upi | card | netbanking | wallet
  status              text not null,        -- created|authorized|captured|failed|refunded
  amount_paise        bigint not null,
  error_code          text,
  error_description   text,
  error_reason        text,
  acquirer_data       jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index payment_attempts_order_idx on payment_attempts (order_id);
create index payment_attempts_captured_idx on payment_attempts (order_id)
  where status = 'captured';

create trigger payment_attempts_touch before update on payment_attempts
  for each row execute function app.touch_updated_at();

create table refunds (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references orders(id),
  razorpay_refund_id text unique not null,   -- makes the refund route idempotent
  amount_paise       bigint not null check (amount_paise > 0),
  status             text not null,
  created_at         timestamptz not null default now()
);

create table disputes (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id),
  razorpay_dispute_id text unique not null,
  status              text not null,
  amount_paise        bigint,
  respond_by          timestamptz,
  created_at          timestamptz not null default now()
);

-- ============================================================================
-- Authorization artefacts.
-- Option A (Clerk reverification) and Option B (WebAuthn assertion) share this
-- table; `kind` discriminates. UNIQUE (kind, ref) IS the single-use guarantee.
-- ============================================================================

create type auth_kind as enum ('clerk_reverification', 'webauthn_assertion');

create table payment_authorizations (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id),
  kind          auth_kind not null,
  ref           text not null,        -- reverification_id (A) | consumed challenge (B)
  credential_id text,                 -- Option B only; NOT the single-use artefact
  amount_paise  bigint not null,      -- what was authorized, for the mismatch check
  user_id       text not null,
  created_at    timestamptz not null default now(),
  unique (kind, ref)
);

-- DORMANT (Option B, Sprint 6). Present now so the schema is stable.
--
-- Nothing in src/ reads or writes this table today. Clerk holds the real
-- credentials: it mints the challenge and the rp.id, and our backend never
-- receives authenticatorData / signature / clientDataJSON. Every row here would
-- be written by an own-credential ceremony we have not built. Do not read
-- "table exists" as "we store public keys" — grep for it before you believe it.
create table webauthn_credentials (
  id              text primary key,     -- base64url TEXT, never bytea
  user_id         text not null references app_users(clerk_id) on delete cascade,
  public_key      text not null,        -- COSE key as base64url TEXT (see §11: bytea
                                        -- does not round-trip through PostgREST)
  counter         bigint not null default 0,
  transports      text[],
  aaguid          text,                 -- often all-zeros with attestationType 'none'
  backup_eligible boolean not null,     -- BE: MUST NOT ever change
  backup_state    boolean not null,     -- BS: may legitimately change
  device_label    text,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz
);

create index webauthn_credentials_user_idx on webauthn_credentials (user_id);

-- DORMANT (Option B, Sprint 6), and the same warning applies as above: no
-- route creates or consumes a challenge. app.create_payment_challenge /
-- app.consume_payment_challenge in 0002 are exercised ONLY by
-- tests/gates/challenge.test.ts, which pins their semantics (atomic single-use,
-- amount read via INSERT..SELECT) so the functions are provably correct on the
-- day Option B is wired. Today the live gesture is Clerk reverification —
-- see src/app/api/pay/authorize/route.ts.
create table payment_challenges (
  challenge    text primary key,        -- base64url, exactly as sent to the client
  user_id      text not null,
  order_id     uuid not null references orders(id),
  amount_paise bigint not null,         -- SELECTed from orders, never from a request
  currency     text not null default 'INR',
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz
);

create index payment_challenges_expiry_idx on payment_challenges (expires_at)
  where consumed_at is null;

-- ============================================================================
-- Webhook ledger. At-least-once and out-of-order delivery are guaranteed by
-- Razorpay, so this is a durable inbox with its own retry state.
-- ============================================================================

create table razorpay_webhook_events (
  event_id            text primary key,      -- X-Razorpay-Event-Id
  event_type          text not null,
  razorpay_created_at timestamptz not null,
  payload             jsonb not null,
  status              text not null default 'pending',  -- pending|processed|error|dead
  attempts            int not null default 0,
  next_attempt_at     timestamptz not null default now(),
  last_error          text,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  -- payload holds email/contact/card last4. DPDP purpose limitation: purge it.
  purge_after         timestamptz not null default (now() + interval '180 days')
);

create index webhook_due_idx on razorpay_webhook_events (next_attempt_at)
  where status in ('pending', 'error');
create index webhook_purge_idx on razorpay_webhook_events (purge_after)
  where status = 'processed';

-- ============================================================================
-- Audit log and rate limits
-- ============================================================================

create table auth_audit_log (
  id            bigserial primary key,
  user_id       text,
  order_id      uuid,
  event         text not null,
  outcome       text not null,           -- success | failure
  credential_id text,
  ip            inet,
  user_agent    text,
  detail        jsonb,
  created_at    timestamptz not null default now()
);

create index auth_audit_user_idx  on auth_audit_log (user_id, created_at desc);
create index auth_audit_order_idx on auth_audit_log (order_id);

create table rate_limits (
  bucket       text primary key,
  count        int not null default 0,
  window_start timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security
--
-- Load-bearing property: RLS enabled with ZERO policies denies anon and
-- authenticated outright, while service_role bypasses RLS entirely. Server
-- routes use the service-role key; clients never write.
-- ============================================================================

alter table app_users            enable row level security;
alter table orders               enable row level security;
alter table payment_attempts     enable row level security;
alter table webauthn_credentials enable row level security;
alter table auth_audit_log       enable row level security;
alter table products             enable row level security;
alter table stores               enable row level security;

-- service-role only: RLS on, no policies at all
alter table product_prices          enable row level security;
alter table staff                   enable row level security;
alter table payment_challenges      enable row level security;
alter table payment_authorizations  enable row level security;
alter table razorpay_webhook_events enable row level security;
alter table rate_limits             enable row level security;
alter table refunds                 enable row level security;
alter table disputes                enable row level security;

-- Clerk subject, not auth.uid(). The (select ...) wrapper lets the planner
-- evaluate the claim once per statement instead of once per row.
create policy own_user on app_users
  for select to authenticated
  using ((select auth.jwt() ->> 'sub') = clerk_id);

create policy own_orders on orders
  for select to authenticated
  using ((select auth.jwt() ->> 'sub') = user_id);

create policy own_attempts on payment_attempts
  for select to authenticated
  using (exists (
    select 1 from orders o
     where o.id = payment_attempts.order_id
       and o.user_id = (select auth.jwt() ->> 'sub')
  ));

create policy own_credentials on webauthn_credentials
  for select to authenticated
  using ((select auth.jwt() ->> 'sub') = user_id);

-- Catalogue is public; prices are not (product_prices stays service-role only,
-- so a client cannot enumerate historical pricing).
create policy catalogue_readable on products
  for select to anon, authenticated using (active);
create policy stores_readable on stores
  for select to anon, authenticated using (active);

-- Deliberately NOT exposing auth_audit_log to end users: it carries ip,
-- user_agent and a free-form detail jsonb, and there is no SELECT policy and no
-- table grant for it.
--
-- A customer-facing security history goes through this narrowed view instead.
-- It is intentionally NOT security_invoker: it runs with the view owner's
-- privileges so the caller never needs rights on the base table, and the view's
-- own WHERE clause does the per-user filtering against the Clerk subject.
-- Only the three safe columns are projected.
create view my_security_events as
  select event, outcome, created_at
    from auth_audit_log
   where user_id = (select auth.jwt() ->> 'sub');

grant select on my_security_events to authenticated;

grant select on products, stores to anon, authenticated;
grant select on app_users, orders, payment_attempts, webauthn_credentials to authenticated;
