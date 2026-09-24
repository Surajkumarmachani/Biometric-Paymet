/**
 * Local dev worker — runs the cron routes that Vercel would run in production.
 *
 * In production `vercel.json` schedules the drain and reconciler every minute;
 * locally nothing does, so a real payment would sit in the ledger unprocessed.
 * This script pokes the internal routes with INTERNAL_TASK_SECRET so you can
 * watch the webhook -> ledger -> drain -> paid path settle.
 *
 *   npm run worker           # one pass: drain + reconcile, print the reports
 *   npm run worker -- --watch        # every 5s until Ctrl-C
 *   npm run worker -- --watch 2000   # every 2s
 *
 * Reads INTERNAL_TASK_SECRET and the base URL from .env.local (or the
 * environment). Talks only to localhost.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function envValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key]
  try {
    const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() !== key) continue
      let v = trimmed.slice(eq + 1).trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1)
      }
      return v
    }
  } catch {
    // no .env.local — fall through
  }
  return undefined
}

const secret = envValue('INTERNAL_TASK_SECRET')
if (!secret) {
  console.error('INTERNAL_TASK_SECRET not found in env or .env.local')
  process.exit(1)
}
const base = (envValue('NEXT_PUBLIC_APP_ORIGIN') ?? 'http://localhost:3000').replace(/\/$/, '')

async function hit(path: string): Promise<void> {
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'x-internal-secret': secret as string },
    })
    const body = await res.json().catch(() => ({}))
    const stamp = new Date().toISOString().slice(11, 19)
    console.log(`${stamp}  ${res.status}  ${path}  ${JSON.stringify(body)}`)
  } catch (err) {
    console.error(`FAILED ${path}:`, err instanceof Error ? err.message : err)
  }
}

async function pass(): Promise<void> {
  await hit('/api/internal/drain')
  await hit('/api/internal/reconcile')
}

const args = process.argv.slice(2)
const watch = args.includes('--watch')

// One-shot settlement reconciliation (calls the Razorpay settlements API, so
// it's not part of the frequent drain/reconcile loop):
//   npm run worker -- settle
if (args.includes('settle')) {
  await hit('/api/internal/settlement-recon')
} else if (!watch) {
  await pass()
} else {
  const intervalArg = args.find((a) => /^\d+$/.test(a))
  const interval = intervalArg ? Number(intervalArg) : 5000
  console.log(`worker watching ${base} every ${interval}ms — Ctrl-C to stop`)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pass()
    await new Promise((r) => setTimeout(r, interval))
  }
}
