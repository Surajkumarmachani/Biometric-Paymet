# Operational runbooks

Every entry maps to an alert emitted by `alertOn()` (a structured log line with
`"alert": true`, and — if `ALERT_WEBHOOK_URL` is set — a Slack message). Wire
your log drain to `alert:true` and page on the criticals below.

**Inspect anything** with `npm run orders` (payments/ledger) and the Supabase
Table Editor. Run the workers manually with `npm run worker`.

---

## 🔴 `late_authorisation` — customer charged on an abandoned order

**Means:** a UPI capture arrived after we gave up on the order. The customer's
money moved; the order was `abandoned`. This is money owed a customer.

**Do now:**
1. `npm run orders -- <order-id>` — confirm `captured` payment, status now `paid`.
2. If fulfilment didn't run, it will on the next drain — check the order flipped.
3. If the goods can't be fulfilled, **refund** (Razorpay dashboard) and note it.

**Never** ignore this — it is the one alert that means a real person paid and
might get nothing.

---

## 🔴 `webhook_dead` — a webhook event exhausted retries

**Means:** an event failed 8 drain attempts and is parked `dead` in
`razorpay_webhook_events`.

**Do now:**
1. Read the row's `last_error` (Supabase → `razorpay_webhook_events`, status `dead`).
2. Fix the cause (schema drift, a bad payload path, an API outage).
3. Requeue: set `status='pending', next_attempt_at=now(), attempts=0`, then
   `npm run worker`.

---

## 🔴 `webhook_rejected` — a payment with no order

**Means:** a captured payment couldn't be matched to an order (`payment has no
order_id`, or an order we never created).

**Do now:** look it up in the Razorpay dashboard by payment id; if it's ours,
reconcile manually and refund if it can't be fulfilled. If it's not ours, it may
be a mis-routed webhook — verify the webhook secret.

---

## 🟠 `high_value_order` — order at/above the review threshold

**Means:** an order ≥ `RISK_REVIEW_PAISE` (default 80% of the cap) was created —
allowed, but worth a look for a new/large customer.

**Do now:** glance at the customer + amount. No action needed unless it looks
fraudulent; if so, refund before fulfilment and consider lowering
`RISK_MAX_ORDER_PAISE`.

---

## 🟠 `risk_declined` (spike) — many orders over the cap

**Means:** a burst of over-cap attempts. One is normal (someone tried a big
basket); a spike can be probing or a mis-set cap.

**Do now:** check `auth_audit_log` for `risk_declined` frequency + which user/IP.
If a legit product genuinely exceeds the cap, raise `RISK_MAX_ORDER_PAISE`.

---

## 🟠 `otp_fallback` `global_ceiling_tripped` — OTP global ceiling hit

**Means:** OTP sends across all users crossed `otpGlobal` (500/hr) — likely
SMS-pumping / toll fraud, since each send can cost money.

**Do now:**
1. Check `rate_limits` (`bucket like 'otp%'`) and `auth_audit_log` `otp_fallback`
   for the offending IPs.
2. Block the IPs upstream if needed; the per-IP / per-identifier limits already
   throttle them.
3. Only reset buckets (`delete from rate_limits where bucket like 'otp%'`) once
   the abuse has stopped.

---

## 🟡 `invoice_failed` — a paid order didn't get its invoice

**Means:** fulfilment succeeded but `app.issue_invoice` threw. The order is
`paid`; the invoice is just missing.

**Do now:** the invoice is issued on demand when the customer opens
`/orders/<id>/invoice`. To backfill proactively, re-open that page or re-run the
issue path. Check the seller GST env is set.

---

## Escalation

- **Money-at-risk (🔴):** page on-call immediately.
- **Review (🟠):** same-day triage.
- **Degraded (🟡):** next business day.
