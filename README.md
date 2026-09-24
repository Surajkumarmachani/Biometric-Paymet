# REGAL LAB — biometric checkout

Touchless checkout: customers pay on their own devices, India domestic (INR),
in-store QR + web entry.

Sprints 1–5 are built and proven, including a real ₹1 payment and refund on
test-mode rails. `npm test` is **169 gates**.

> **On the architecture doc.** Section numbers in these comments (§4.1, §11,
> §12) refer to `biometric-checkout-architecture-v3.md`, which is **not
> committed to this repo** — it lives with the Machani Group brief. Nothing here
> requires it: every decision it drove is restated at the point of use, and the
> two that matter most are "Option A" (the gesture — see
> [`src/app/api/pay/authorize/route.ts`](src/app/api/pay/authorize/route.ts))
> and the three rules below. Treat the code and the gates as authoritative; if
> the doc and this repo disagree, the repo is what runs.

**Read this before writing any code against it:**

> The customer's passkey is a **merchant-side control, not a regulatory factor.**
> Under the RBI (Authentication mechanisms for digital payment transactions)
> Directions, 2025, the Additional Factor of Authentication obligation *and the
> full customer-compensation liability* sit with the **card issuer**. Our
> WebAuthn/Clerk step-up authenticates the customer to *us* and authorises the
> use of a stored instrument. It does **not** replace the issuer's OTP or 3DS.
>
> What we ship is **"no forms, no card numbers, no CVV, one gesture"** — not
> "no authentication". There is no zero-gesture path.

---

## What's in it

| | |
|---|---|
| **Rails** | Razorpay Standard Checkout — UPI Intent on mobile, QR on desktop, tokenised cards. **Not** Stripe (invite-only in India, no UPI, no local payment methods), and **not** S2S (needs PCI-DSS certification). |
| **Money** | Server-side pricing from `product_prices`. The client sends `{sku, qty}` and never an amount, anywhere in the flow. |
| **The gesture** | Option A: Clerk passkey reverification, single-use via `UNIQUE (kind, ref)` on `payment_authorizations`, bound to order + amount + user. |
| **Truth** | Razorpay webhook → durable ledger → drain worker that re-reads state from the API. The browser callback is advisory only. |
| **Safety net** | Reconciler that polls `GET /v1/orders/:id/payments`, which resolves the dominant UPI failure mode (customer's app took over, callback never fired). |
| **Identity** | Passkey enrol + credential management (`/account/security`), device-capability probe, rate-limited OTP contact fallback. |
| **In store** | Staff terminal (`/staff/terminal`) → product picker → QR + live order tile. Staff order lookup + refunds (`/staff/orders`), behind a passkey step-up. |
| **Compliance** | GST invoices with per-FY consecutive numbering, credit notes on refund/chargeback, `/orders` history, settlement reconciliation, risk caps, weekly ZAP baseline. |
| **Not yet** | Own-credential WebAuthn (Option B, Sprint 6) — see *Dormant by design* below. |

## The three rules the whole design rests on

1. **Price is computed server-side** from your own tables. No endpoint accepts an amount.
2. **The Razorpay order amount comes from the database**, via the authorization record or the consumed challenge — never from a request body.
3. **The webhook is the source of truth.** The browser callback and the terminal display are advisory.

---

## Quick start

```bash
npm install
cp .env.example .env.local        # fill in real values

# Local Postgres for the test suite (skip if you have Supabase running locally)
npm run db:pg:start
export TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5433/postgres

npm test          # 169 gates against real Postgres
npm run typecheck
npm run build
```

Against a real Supabase project:

```bash
export DATABASE_URL='postgresql://postgres:...@db.<ref>.supabase.co:6543/postgres?pgbouncer=true'
npm run db:reset          # applies 0001..0011; skips the local auth shim (0000)
```

### Running the whole app on local Postgres (no Supabase)

Supabase is only load-bearing for one thing — Realtime on the store terminal —
and the terminal already polls `/api/orders/[id]/status` every 5s as its safety
net. So the app runs end to end against a plain local Postgres, which is the
fastest way back to a working dev box when a hosted project goes away:

```bash
npm run db:pg:start        # cluster on 127.0.0.1:5433
createdb -h 127.0.0.1 -p 5433 -U postgres regal
npm run db:local:reset     # every migration, including the 0000 auth shim
npm run staff -- you@example.com     # grant yourself the terminal
```

Then point `DATABASE_URL` at `postgresql://postgres@127.0.0.1:5433/regal` and
leave `NEXT_PUBLIC_SUPABASE_URL` unset — `OrderTile` checks for it and skips the
subscription rather than throwing. Tiles then update on the 5s poll instead of
instantly.

### Testing on a real phone

```bash
npm run dev:phone
```

Starts an ngrok tunnel, the dev server, and the drain/reconcile worker, then
prints the HTTPS URL to open the terminal on. Load `/staff/terminal` **through
that URL** — the QR copies whatever origin the terminal was served from, so a
`localhost` terminal produces a QR that sends the phone to itself. HTTPS is not
optional either: passkeys need a secure context, which rules out a plain LAN IP.

ngrok needs a one-time `ngrok config add-authtoken <token>`. On the free plan
the first page load on each device shows ngrok's "You are about to visit"
interstitial — tap **Visit Site** once on the laptop and once on the phone; it
is remembered by cookie and does not touch the payment flow. `--cloudflared`
switches to a Cloudflare quick tunnel instead, which has no interstitial and
needs no account, but hands out an unreachable hostname often enough that the
script retries three times.

`npm run staff` grants terminal access (`-- --list` to see who has it);
`npm run orders` is a read-only inspector for what actually settled.

## Wiring checklist

**Clerk.** Add a custom session token claim, or `/api/pay/authorize` fails closed:

```json
{ "reverification_id": "{{session.reverification_id}}" }
```

Then wire Clerk as a Supabase third-party auth provider, so the RLS policies see
`auth.jwt()->>'sub'`.

**Razorpay.** Create the webhook in the Dashboard (test mode OTP is `754081`) and
subscribe at minimum: `payment.captured`, `payment.failed`, `order.paid`, plus
`refund.*` and the six `payment.dispute.*` events. The webhook secret is
**separate** from `RAZORPAY_KEY_SECRET`.

**Crons.** `vercel.json` schedules the drain and reconciler every minute, plus a
daily sweep (03:17) and settlement recon (04:42). **The drain is not optional** —
a ledger with no consumer is a queue that fills forever and nothing is ever
fulfilled. The sweep is not optional either: it is the only thing enforcing
retention on the audit log and OTP rows.

**OTP delivery.** Set `RESEND_API_KEY` + `OTP_EMAIL_FROM` (email) and
`TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` / `_FROM` (SMS) before you rely on the
contact fallback. With neither configured, dev prints the code to the server log
and production logs a `otp_delivery_unconfigured` error **without** the code — so
the feature fails closed and silently in prod if you skip this.

**MCC.** Set `MERCHANT_MCC`. Jewellery (`5944`) caps UPI at **₹2,00,000** per
transaction — *not* ₹5,00,000, which is the insurance/capital-markets/card-bills
bucket. Above the cap `decideRails()` routes to card or bank transfer and tells
the customer why. **Confirm your assigned MCC and enabled limit with your
acquirer in writing** and override with `UPI_CAP_OVERRIDE_PAISE` if they differ.

---

## Layout

```
supabase/migrations/
  0000_local_supabase_shim.sql   LOCAL TEST ONLY — auth schema + roles
  0001_schema.sql                tables, RLS, the narrowed audit view
  0002_functions.sql             the invariants, in the database
  0003_seed_dev.sql              fixtures straddling the ₹2,00,000 UPI cap
  0004_otp.sql                   OTP challenges, hashed + attempt-capped
  0005_staff_orders_rls.sql      staff see only their own store's orders
  0006_invoices.sql              GST invoices, per-FY consecutive numbering
  0007_settlements.sql           settlement + per-txn recon, gross-vs-captured
  0008_refund_sticky.sql         chargeback must not be demoted to refunded
  0009_credit_notes.sql          GST credit notes for refunds/chargebacks
  0010_poll_failed.sql           late-auth heartbeat for payment_failed orders
  0011_retention.sql             sweep actually purges OTP rows + audit log

src/lib/
  db.ts          lazy client + jsonb() — read its comment before binding jsonb
  money.ts       integer paise; refuses anything else
  rails.ts       UPI caps by MCC, amount-based rail routing
  orders.ts      service layer; no function here accepts an amount
  drain.ts       ledger drain + order reconciler
  auth.ts        Clerk: requireUser / requireStepUp / requireStaff
  rate-limit.ts  Postgres-backed; note the OTP buckets
  risk.ts        per-order hard cap + high-value flag, before money moves
  invoice.ts     tax-inclusive CGST/SGST split; credit-note.ts mirrors it
  settlement.ts  payout reconciliation against Razorpay
  otp.ts         contact-point fallback — read its header before extending it
  audit.ts       audit rows + alertOn() (log + optional Slack webhook)
  razorpay/      verify.ts (both HMACs), api.ts (the calls we need)

src/app/api/     routes; every one is runtime=nodejs + force-dynamic
scripts/         worker.mts (drain+reconcile locally), orders.mts (inspector)
docs/            go-live checklist, runbooks, on-floor rehearsal
tests/gates/     correctness gates against real Postgres
tests/unit/      HMAC verifiers, money, rail routing, risk
```

### Dormant by design

Three pieces of surface exist but are **not wired**. They are labelled
`DORMANT` at the definition so nobody mistakes them for shipped capability:

| Surface | Reality |
|---|---|
| `webauthn_credentials`, `payment_challenges`, `app.create_payment_challenge` / `app.consume_payment_challenge`, `auth_kind = 'webauthn_assertion'` | Option B (Sprint 6). No route touches them. Clerk holds the credentials and mints the challenge, so **we never see an assertion to verify** and store no public keys. The challenge gates run anyway, so the semantics are pinned for the day it is built. |
| `WEBAUTHN_RP_ID` / `_RP_NAME` / `_ALLOWED_ORIGINS`, `allowedOrigins()` | Option B only. No caller. `allowedOrigins()` throws on a missing allowlist rather than defaulting — correct for an origin check. |
| `OtpPurpose = 'fallback_signin'` | Not reachable: both OTP routes `requireUser()` first, so a signed-in caller cannot use it to sign in. Clerk owns sign-in, including the no-passkey path. |

**What Option A does and does not buy you.** Clerk owning the ceremony means
there is no cryptographic transaction binding — we cannot prove *this device
signed for this amount*, because the signature never reaches us. What we bind
instead is Clerk's `reverification_id`: fresh per step-up, stored against the
order under `UNIQUE (kind, ref)`, pre-rejected if already spent, re-checked
against the order amount in `app.record_authorization`. That is a real control
and the gates prove it holds. It is **not** equivalent to verifying an
assertion. Building Option B is the only thing that closes that gap.

### Why the invariants live in SQL

`app.create_order`, `app.create_payment_challenge`,
`app.consume_payment_challenge`, `app.record_authorization`,
`app.attach_razorpay_order` and `app.apply_payment_event` are `SECURITY DEFINER`
functions granted only to `service_role`. There is no other way to move an order
forward, so a future developer wiring a new route cannot accidentally skip a
guard. Two of them rely on properties application code cannot express safely:

- `create_payment_challenge` does `INSERT .. SELECT`, so the amount is read from
  `orders` rather than accepted from a caller.
- `consume_payment_challenge` is one atomic `UPDATE .. RETURNING`, so
  check-then-use cannot race.

---

## What the gates actually pin down

`npm test` — 169 assertions. The ones that matter:

- **Price tamper.** Injected `amount_paise` / `unit_paise` / `line_paise` in the payload are ignored. A partially-priceable basket fails wholesale rather than silently dropping a line.
- **Challenge replay.** Single-use, atomic, one winner under concurrency. Consumption **returns the challenge** (omitting it silently makes `expectedChallenge` undefined — the exact "tolerating a mismatch will compromise the security of the protocol" failure the WebAuthn spec warns about). One test deliberately demonstrates that wrapping consume+verify in a single transaction reopens the replay window.
- **Reverification replay.** A reused Clerk `reverification_id` is rejected by the unique constraint.
- **QR claim.** Idempotent for the same customer (a refresh must not dead-end), single-winner across different customers, verified under a real concurrent race.
- **Paid is never demoted.** A stale `payment.failed` for attempt 1 arriving *after* attempt 2 captured leaves the order `paid`.
- **Abandoned is not terminal.** A late UPI capture flips an abandoned order to `paid` and raises `late_authorisation` — the customer *was* charged.
- **Exactly-once fulfilment.** `payment.captured` and `order.paid` co-fire; five redeliveries produce one fulfilment and one stable receipt number.
- **Amount mismatch.** A captured payment whose amount or currency differs from the order is refused outright.
- **RLS.** `auth.uid()` is proven to *break* on a Clerk subject (this is why policies use `->>'sub'`). Service-role-only tables are denied to both `anon` and `authenticated`, and prices are shown to exist while being unreadable — so the denial is real, not an empty table.
- **Ledger payload shape.** One test stores a payload the wrong way and asserts the drain's lookup path vanishes — the bug that would have made the webhook return 200 forever while fulfilling nothing.

### Two bugs the gates caught during the build

Both were live in the first pass and both are the kind that fail silently in
production:

1. **`${JSON.stringify(x)}::jsonb` is wrong under postgres.js.** A JS string bound to a json parameter is JSON-*encoded*, so the value stored is a jsonb `string`, not an object. Every `jsonb_typeof(...) = 'array'` guard failed, and in the webhook route it meant the stored payload had no navigable `payment.entity.id` — the endpoint would have returned 200 forever while no order was ever fulfilled. Always use `jsonb()` from `lib/db.ts`.
2. **Eager DB client at module scope** broke `next build`, because Next imports every route module to analyse it and `DATABASE_URL` is a runtime secret. The client is now lazily connected behind a proxy.

---

## Still to do before real money moves

**→ [docs/go-live-checklist.md](docs/go-live-checklist.md) is the single source of
truth.** This README used to keep a second, shorter copy; the two drifted (the
duplicate had TokenHQ, the checklist had the GST and secrets work, and neither
had all of it), so there is now exactly one list.

Longest lead time first, none of it code: registered entity and current account
in the business's legal name → Razorpay KYC and live keys → MCC and UPI limit
confirmed **in writing** → CA sign-off on GST → TokenHQ requested → PCI SAQ A →
the policy pages PA onboarding blocks activation without.

One question to send Razorpay early, because it decides what you may claim:
**does 3DS/AFA fire on repeat *on-session* tokenised card payments?** CVV-less
removes the CVV; that is not the same as removing AFA, and no Razorpay page
states it either way. Assume AFA fires until told otherwise in writing.
