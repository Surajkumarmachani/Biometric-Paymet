# Go-live checklist — REGAL LAB

**This file is the single source of truth for go-live.** README.md links here and
deliberately does not keep its own copy — two lists drift, and they did.

Status of the build and everything that must be true before **real money** moves.
Companion docs: [runbooks.md](runbooks.md), [on-floor-rehearsal.md](on-floor-rehearsal.md).

---

## ✅ Done in code — production-quality, 169 gates green

- **S1 Rails & money path** — server-side pricing, Razorpay Standard Checkout,
  webhook → durable ledger → drain, reconciler. Money is integer paise; every
  invariant is SQL-enforced (`SECURITY DEFINER`, service-role only).
- **S2 Identity** — Clerk auth, passkey enrol + credential management UI, OTP
  contact fallback (rate-limited), device matrix.
- **S3 Passkey ↔ payment binding** — reverification required on authorize,
  bound to order+amount+user, single-use `reverification_id`.
- **S4 In-store QR** — staff terminal, store-scoped RLS, claim tokens, Realtime
  tile. Plus staff order lookup + refunds behind a step-up, and `/orders`
  customer history → invoices.
- **S5 Hardening** — risk layer + amount caps, GST invoice engine, alerts +
  runbooks, settlement reconciliation, ZAP DAST.
- **Post-S5** — chargeback no longer demoted to refunded (`0008`), GST credit
  notes on refund/chargeback (`0009`), late-authorisation heartbeat for
  `payment_failed` orders (`0010`), OTP + audit retention actually enforced in
  the daily sweep (`0011`).

These are **mechanisms**. The items below make them real.

---

## ⛔ Blockers — must be done before go-live (mostly not code)

### Legal / business
- [ ] Registered entity, PAN/GST, current account **in the business's legal name**
- [ ] Razorpay **KYC approved, live keys** issued (`rzp_live_…`)
- [ ] **MCC + enabled UPI per-transaction limit confirmed in writing** by the acquirer
      → set `MERCHANT_MCC` / `UPI_CAP_OVERRIDE_PAISE` to match
- [ ] **GST correctness signed off by a CA**: real `GST_SELLER_GSTIN`,
      `GST_SELLER_STATE_CODE`, `GST_RATE_BPS`, and **per-product HSN** (set
      `products.hsn`). The invoice engine is built; the tax treatment is yours.
- [ ] **TokenHQ requested** (on-demand feature, has a network onboarding
      process — start it early, it is not instant)
- [ ] **PCI SAQ A** self-assessment completed (Standard Checkout removes
      certification, not the annual self-assessment)
- [ ] Site has **Terms, Refund/Cancellation, Privacy, Shipping, Contact** pages
      (PA onboarding blocks activation without them)
- [ ] **Data-retention window signed off** — `app.sweep()` defaults to **400
      days** for `auth_audit_log`. Confirm it against your DPDP position and your
      chargeback/arbitration exposure; the reasoning is written out at the top of
      `supabase/migrations/0011_retention.sql`. Disputed orders are exempt.
- [ ] Ask Razorpay **in writing**: does 3DS/AFA fire on repeat on-session
      tokenised card payments? (decides what you may claim). CVV-less removes the
      CVV; that is not the same as removing AFA, and no Razorpay page states it
      either way. **Assume AFA fires until told otherwise in writing.**

### Clerk instance config (blocks customer sign-up)
- [ ] **Phone number must NOT be a required sign-up field.** Clerk does not
      support SMS to India, so a required phone field rejects every `+91` number
      it just demanded — *"Phone numbers from this country (India) are currently
      not supported"*. Every Indian customer is hard-blocked at sign-up.
      Fix: **User & Authentication → Email, Phone, Username → Phone number: Off**.
      Observed live on 2026-08-24 on a Google sign-in. If you need verified
      phone numbers, do it AFTER sign-up with our own OTP (`src/lib/otp.ts`,
      Twilio) — and budget for **DLT sender/template registration**, which
      Indian transactional SMS requires and which has a lead time.
- [ ] **`role: "authenticated"` must be in the session token**, alongside
      `reverification_id`. Supabase third-party auth needs it to assume the
      `authenticated` role; without it Realtime silently delivers nothing and
      the staff terminal tile never leaves CLAIMED (observed live 2026-08-24 —
      order captured 12:56:50, tile stale at 12:58:00). Server routes use
      service_role and are unaffected, which is why this hides.
      Fix: **Sessions → Customize session token**:
      `{ "role": "authenticated", "reverification_id": "{{session.reverification_id}}" }`

### Secrets / config
- [ ] **Rotate the Supabase DB password** (it passed through chat during setup)
- [ ] Swap all keys to **live**: Razorpay, Clerk production instance, Supabase prod
- [ ] Set live **`RAZORPAY_WEBHOOK_SECRET`** and point the Razorpay webhook at the
      production `/api/webhooks/razorpay` (subscribe payment.captured/failed,
      order.paid, refund.*, the 6 dispute events)
- [ ] Set `GST_SELLER_*`, `ALERT_WEBHOOK_URL`, and confirm `RISK_MAX_ORDER_PAISE`
- [ ] Set **OTP delivery** keys — `RESEND_API_KEY` + `OTP_EMAIL_FROM` (email),
      `TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` / `_FROM` (SMS). Without them the
      fallback **fails closed and silently in production**: it logs
      `otp_delivery_unconfigured` and no code is ever sent.
- [ ] `INTERNAL_TASK_SECRET` regenerated for prod
- [ ] ~~Set `WEBAUTHN_ALLOWED_ORIGINS` / `WEBAUTHN_RP_ID`~~ — **not required.**
      These are dormant (Option B, Sprint 6): nothing reads them, because Clerk
      owns the WebAuthn ceremony. Setting them buys you nothing and implies a
      control you do not have. See "Dormant by design" in README.md.

### Infrastructure / deploy
- [ ] Deploy to a real host (Vercel) so the **crons actually run** (drain,
      reconcile, sweep, settlement-recon) — they do **not** run locally
- [ ] A **production Supabase project** (separate from the dev one), migrations
      **`0001…0016`** applied via `npm run db:reset`. It skips 0000 (local-test
      auth shim) and 0003 (dev seed: ₹1 test products, a fake store and staff
      row) by default; never pass `--with-shim` or `--with-seed` against prod. Applying only through 0007 leaves you without
      chargeback stickiness, credit notes, the late-auth heartbeat, and retention.
- [ ] Clerk wired as a **Supabase third-party auth provider** on prod, and the
      `reverification_id` session claim added — `/api/pay/authorize` fails closed
      without it
- [ ] Real domain + HTTPS (no tunnel); Clerk passkeys enabled on the prod instance
- [ ] Alerting destination live (`ALERT_WEBHOOK_URL`) + log drain on `alert:true`

### Verification (do in live mode)
- [ ] A **₹1 live transaction end-to-end, then refunded**, on **every rail**
      (UPI, card, netbanking)
- [ ] Live smoke test of the **UPI cancel** path (test mode reports cancels as
      success, so it can't exercise this)
- [ ] Confirm a refund reaches `refund.processed` in live mode and the **credit
      note** is issued — test mode leaves refunds `pending`, so the accounting
      leg of the refund path is unproven until live
- [ ] **On-floor rehearsal** (see on-floor-rehearsal.md) incl. the failure drills
- [ ] **ZAP** baseline reviewed and findings triaged (`npm run zap` / CI)
- [ ] Confirm settlement reconciliation against a **real** payout + bank statement
      (test mode returns 0 settlements, so this is untested by construction)
- [ ] Confirm the daily **sweep** ran and reported non-zero purges once there is
      real traffic — a silently-stopped sweep is invisible

---

## Quick reference

| Need to… | Do |
|---|---|
| Inspect payments | `npm run orders` |
| Run drain/reconcile locally | `npm run worker` (or `-- --watch`) |
| Run settlement recon | `npm run worker -- settle` |
| Run gates | `npm run db:pg:start && npm test` |
| Security scan | `npm run zap` |
| Handle an alert | docs/runbooks.md |
