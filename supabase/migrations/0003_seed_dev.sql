-- ============================================================================
-- 0003_seed_dev.sql — development / test fixtures only.
-- Safe to run repeatedly. Do NOT apply to production.
--
-- Prices are chosen to sit either side of the jewellery UPI ceiling
-- (₹2,00,000 per transaction, MCC 5944) so the rail-routing tests are real.
-- ============================================================================

insert into stores (id, name, mcc, active) values
  ('11111111-1111-1111-1111-111111111111', 'REGAL LAB — Flagship', '5944', true)
on conflict (id) do nothing;

insert into app_users (clerk_id, email) values
  ('user_customer_alice', 'alice@example.com'),
  ('user_customer_bob',   'bob@example.com'),
  ('user_staff_priya',    'priya@regallab.example')
on conflict (clerk_id) do nothing;

insert into staff (clerk_id, store_id, role, active) values
  ('user_staff_priya', '11111111-1111-1111-1111-111111111111', 'manager', true)
on conflict (clerk_id) do nothing;

insert into products (id, sku, name, active) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'RL-CUFF-01',  'Meridian Cuff',            true),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'RL-RING-02',  'Solitaire Ring',           true),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'RL-NECK-03',  'Cascade Necklace',         true),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'RL-PIN-04',   'Lapel Pin',                true),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'RL-GONE-05',  'Discontinued Bangle',      false),
  ('aaaaaaaa-0000-0000-0000-000000000099', 'RL-TEST-01',  'Test Item (₹1)',           true),
  ('aaaaaaaa-0000-0000-0000-000000000098', 'RL-TEST-05',  'Test Item (₹5)',           true)
on conflict (id) do nothing;

-- Current prices (valid_to is null). One current price per product is enforced
-- by the unique index, so these are deterministic.
insert into product_prices (product_id, amount_paise, currency, valid_to) values
  ('aaaaaaaa-0000-0000-0000-000000000001',   4500000, 'INR', null),  -- ₹45,000
  ('aaaaaaaa-0000-0000-0000-000000000002',  20000000, 'INR', null),  -- ₹2,00,000 exactly at UPI cap
  ('aaaaaaaa-0000-0000-0000-000000000003',  35000000, 'INR', null),  -- ₹3,50,000 above UPI cap
  ('aaaaaaaa-0000-0000-0000-000000000004',    100000, 'INR', null),  -- ₹1,000
  ('aaaaaaaa-0000-0000-0000-000000000099',       100, 'INR', null),  -- ₹1 test item
  ('aaaaaaaa-0000-0000-0000-000000000098',       500, 'INR', null)   -- ₹5 test item
on conflict do nothing;

-- A superseded price, to prove line_items.price_id records which row was used.
insert into product_prices (product_id, amount_paise, currency, valid_from, valid_to) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 3900000, 'INR',
   now() - interval '90 days', now() - interval '30 days')
on conflict do nothing;

-- RL-GONE-05 deliberately has NO current price and is inactive: two different
-- ways for a line to fail, both of which must be rejected rather than priced 0.
