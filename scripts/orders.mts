/**
 * Server-side payment inspector — read-only.
 *
 *   npm run orders            # recent orders, newest first
 *   npm run orders -- paid    # only paid orders
 *   npm run orders -- <uuid>  # one order in full: attempts + webhook ledger
 *
 * Reads the same DATABASE_URL the app uses (from the environment or .env.local)
 * and only SELECTs — it never mutates. This is the source of truth for "did the
 * payment confirm": the orders row, its captured amount, its receipt number, and
 * the webhook events that drove it there.
 */
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function envValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key]
  try {
    for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1 || t.slice(0, eq).trim() !== key) continue
      let v = t.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return v
    }
  } catch { /* no .env.local */ }
  return undefined
}

const url = envValue('DATABASE_URL')
if (!url) { console.error('DATABASE_URL not found in env or .env.local'); process.exit(1) }

const inr = (p: unknown) => `₹${(Number(p) / 100).toFixed(2)}`
const arg = process.argv[2]
const isUuid = arg && /^[0-9a-f-]{36}$/i.test(arg)

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

try {
  if (isUuid) {
    const o = (await sql`select * from orders where id = ${arg}::uuid`)[0]
    if (!o) { console.log('no such order'); }
    else {
      console.log(`\nOrder ${o.id}`)
      console.log(`  status        ${o.status}`)
      console.log(`  amount        ${inr(o.amount_paise)}   captured ${inr(o.amount_captured_paise)}   refunded ${inr(o.amount_refunded_paise)}`)
      console.log(`  receipt       ${o.receipt_no ?? '-'}`)
      console.log(`  razorpay      ${o.razorpay_order_id ?? '-'}`)
      console.log(`  user          ${o.user_id ?? '-'}`)
      console.log(`  fulfilled_at  ${o.fulfilled_at ? new Date(o.fulfilled_at).toISOString() : '-'}`)
      const att = await sql`select razorpay_payment_id, method, status, amount_paise, error_reason from payment_attempts where order_id=${arg}::uuid order by created_at`
      console.log(`\n  payment attempts (${att.length}):`)
      for (const a of att) console.log(`    ${a.razorpay_payment_id}  ${String(a.method).padEnd(11)} ${String(a.status).padEnd(10)} ${inr(a.amount_paise)}${a.error_reason ? '  ('+a.error_reason+')' : ''}`)
    }
  } else {
    const where = arg === 'paid' ? sql`where status='paid'` : sql``
    const rows = await sql`
      select id, status, amount_paise, amount_captured_paise, receipt_no, razorpay_order_id, created_at
        from orders ${where} order by created_at desc limit 20`
    if (!rows.length) { console.log('no orders'); }
    console.log(`\n${'created'.padEnd(20)} ${'status'.padEnd(16)} ${'amount'.padEnd(9)} ${'captured'.padEnd(9)} receipt`)
    console.log('-'.repeat(78))
    for (const r of rows) {
      console.log(
        `${new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ')} ` +
        `${r.status.padEnd(16)} ${inr(r.amount_paise).padEnd(9)} ${inr(r.amount_captured_paise).padEnd(9)} ${r.receipt_no ?? '-'}`,
      )
    }
    const paid = rows.filter((r) => r.status === 'paid')
    console.log(`\n${paid.length} paid of ${rows.length} shown. Detail: npm run orders -- <order-id>`)
  }

  // Webhook ledger health — the durable truth path.
  const led = await sql`select status, count(*)::int n from razorpay_webhook_events group by status order by status`
  if (led.length) console.log('\nwebhook ledger:', led.map((l: { status: string; n: number }) => `${l.status}=${l.n}`).join('  '))
} catch (e) {
  console.error('ERROR:', e instanceof Error ? e.message : e)
} finally {
  await sql.end({ timeout: 5 })
}
