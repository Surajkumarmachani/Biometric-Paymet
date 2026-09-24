# On-floor rehearsal — in-store QR checkout (S4)

A scripted dry run of the in-store flow with a real associate and a real phone,
before any live money moves. Do it in test mode first, then once in live mode
with a ₹1 item (see the README's "before real money moves" list).

## Why rehearse

The in-store handover has moving parts that unit tests can't exercise: a QR that
must be *scannable from the customer's own phone*, a sign-in/claim on a second
device, the passkey gesture, and the terminal learning the outcome over
Realtime. The failure modes here are physical and human, not logical.

## Prerequisites

- [ ] A **staff account** (a `staff` row for your store). The signed-in user
      must be staff or `/staff/terminal` shows "not staff".
- [ ] The terminal is loaded on a **URL the customer's phone can reach** — this
      is the #1 thing people get wrong. Just run:

  ```bash
  npm run dev:phone
  ```

  which brings up an ngrok tunnel, the dev server and the drain/reconcile
  worker, and prints the HTTPS URL to open the terminal on. Open
  `/staff/terminal` **through that printed URL**, not localhost.
  (`npm run dev:phone -- --cloudflared` swaps in a Cloudflare quick tunnel.)

  - On the ngrok free plan the first load on each device shows a "You are
    about to visit" interstitial. Tap **Visit Site** — once on the laptop, and
    once more on the phone right after it scans the QR. Cookie-remembered for
    the session; it does not affect the Razorpay sheet or the passkey step-up.
    Worth knowing before you do this in front of a real customer.

  - A `localhost` QR is **not scannable from another device** — it points the
    phone at itself. The route derives the QR origin from the terminal's host,
    so loading the terminal on the right URL is the whole fix.
  - A **LAN IP** (`http://<laptop-ip>:3000`) is scannable on the same wifi, but
    it is plain HTTP, and passkeys need a secure context — so the step-up in
    step 5 will not work. Use the tunnel.
  - The tunnel hostname changes on every restart. Nothing needs editing:
    `next.config.mjs` allowlists the ngrok and Cloudflare domains as dev
    origins, and the QR origin comes from the request host. Both providers
    forward `Host` + `X-Forwarded-Proto: https` (ngrok also sends
    `X-Forwarded-Host`), which is what the QR-origin derivation reads.
- [ ] A payment method that works in test mode: **UPI** (enable it in the
      Razorpay test dashboard first) or **Netbanking** (always works; pick any
      bank → Success). Test cards reject sub-₹1 and international cards.
- [ ] `npm run staff -- you@example.com` if the terminal says "not staff".
      (`npm run staff -- --list` shows who currently has access.)
- [ ] For the webhook truth-path: point the Razorpay test webhook at
      `<tunnel>/api/webhooks/razorpay`. **Optional for a rehearsal** — the
      `/api/pay/confirm` callback re-reads the payment from Razorpay and
      fulfils through the same idempotent path, and the reconciler catches
      anything it misses. `dev:phone` already runs the drain loop for you.

## The rehearsal — happy path

1. **Associate:** open `/staff/terminal`, confirm the store name + role show.
2. **Associate:** add an item (use **Test Item (₹1)**) → **Create order**.
   - ✔ A QR appears, the expiry counts down, and the tile reads the initial
     status (CLAIMED/AWAITING).
3. **Customer:** scan the QR with the phone camera → the `/pay/[token]` page
   opens showing the amount and line items.
   - ✔ The amount matches the terminal. It was priced server-side; the phone
     never sent a number.
4. **Customer:** tap **Continue / Pay** → sign in (or sign up) with Clerk.
   - ✔ First-time customer can create an account here.
5. **Customer:** complete the **passkey / biometric step-up** when prompted.
   - ✔ This is the gesture. No step-up → no payment.
6. **Customer:** the Razorpay sheet opens → pay (UPI intent, or Netbanking →
   Success in test mode).
7. **Both screens:**
   - ✔ The phone shows **Paid** with a receipt number.
   - ✔ The **terminal tile flips to PAID** on its own, over Realtime — the
     associate never had to ask "did it go through?"

Confirm server-side any time with `npm run orders` (status `paid`, a receipt,
`amount_captured_paise` matching).

## Failure drills (run these too — they're the point)

- **Customer switches to their UPI app and comes back:** the phone shows
  "Confirming your payment…", never "failed". The webhook/reconciler settles it.
- **QR expires (wait past the countdown), then scan:** the pay page says the
  code has expired. Associate creates a fresh order.
- **A second phone scans the same QR after the first customer claimed it:** the
  second is refused ("with another customer") — single-winner claim.
- **Refresh the pay page mid-flow on the same phone:** it does *not* dead-end —
  the claim is idempotent for the same customer.
- **A staff member from another store opens the terminal:** they cannot see this
  order's status (store-scoped RLS). Verified by gate, worth seeing live.

## If something's off

- Tile never flips but the phone says Paid → Realtime/RLS: confirm Clerk is a
  Supabase third-party auth provider and `orders` is in the `supabase_realtime`
  publication; the terminal user must be staff for that store.
- QR won't scan from the phone → the terminal was loaded on `localhost`; reload
  it on the tunnel URL.
- Tunnel URL times out **only on the laptop that started it** → macOS cached the
  NXDOMAIN from a lookup made before the tunnel registered. `dev:phone` avoids
  this by polling DNS over c-ares before it ever issues an HTTP request; if you
  hit it with a hand-rolled tunnel, `sudo dscacheutil -flushcache`.
- Razorpay sheet won't open → check the test key and that a method (UPI/
  Netbanking) is enabled on the account.

## Sign-off

- [ ] Happy path completes, terminal flips to PAID unaided.
- [ ] All five failure drills behave as described.
- [ ] One ₹1 **live** transaction end-to-end, then refunded (per README).
