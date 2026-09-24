/**
 * One command to test the in-store flow on a real phone.
 *
 *   npm run dev:phone                  # ngrok (default)
 *   npm run dev:phone -- --cloudflared # Cloudflare quick tunnel instead
 *
 * The in-store handover needs the customer's phone to reach this laptop, and a
 * `localhost` QR points the phone at itself. A LAN IP works only if both
 * devices are on the same wifi and gets you plain HTTP, which rules out
 * passkeys — WebAuthn requires a secure context. So the reliable answer is a
 * public HTTPS tunnel, and that is what this script stands up:
 *
 *   1. a tunnel                   -> https://<something>.ngrok-free.dev
 *   2. `next dev` on :3000        (reused if you already have one running)
 *   3. `npm run worker --watch`   (the drain + reconcile loop Vercel would cron)
 *
 * The QR origin is derived from the terminal's request host (see
 * /api/staff/orders), so loading the terminal through the tunnel URL is all it
 * takes for the QR to be scannable. Nothing needs editing when the hostname
 * changes on restart — next.config.mjs allowlists the tunnel domains for
 * Next's dev-origin check.
 *
 * Two providers, because they fail in opposite ways:
 *
 *   ngrok (default) — needs a one-time `ngrok config add-authtoken`, and on the
 *     free plan the FIRST page load on each device shows ngrok's "You are about
 *     to visit" interstitial. Tap "Visit Site" once and it is cookie-remembered
 *     for the rest of the session. Everything after that, including the Razorpay
 *     sheet and the passkey step-up, is untouched. In exchange the tunnel comes
 *     up immediately and reliably, and the URL is read from ngrok's local API
 *     rather than scraped from a log.
 *
 *   cloudflared (--cloudflared) — no interstitial, no account, but quick-tunnel
 *     hostnames are sometimes dud and it has the DNS trap described in
 *     waitForDns() below.
 *
 * Flags:
 *   --cloudflared   use a Cloudflare quick tunnel instead of ngrok
 *   --no-worker     don't run the drain/reconcile loop
 *   --port <n>      dev server port (default 3000)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promises as dns } from 'node:dns'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const PORT = portArg !== -1 ? Number(args[portArg + 1]) : 3000
const WITH_WORKER = !args.includes('--no-worker')
const PROVIDER: 'ngrok' | 'cloudflared' = args.includes('--cloudflared')
  ? 'cloudflared'
  : 'ngrok'

const children: ChildProcess[] = []
let shuttingDown = false

function shutdown(code = 0): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 300)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/** Prefix every line of a child's output so three processes stay readable. */
function pipeWithPrefix(child: ChildProcess, prefix: string): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    createInterface({ input: stream }).on('line', (line) => {
      if (line.trim()) console.log(`${prefix} ${line}`)
    })
  }
}

/**
 * A probe that answers "can something reach this URL", not "is it healthy".
 *
 * Any HTTP status counts, including Cloudflare's 502/530 while a fresh quick
 * tunnel is still wiring itself up — the point is that the name resolves and
 * the edge answers. Only a network-level failure is "not up". The 10s per
 * attempt matters: the first request through a cold tunnel is slow, and a 3s
 * budget reports a working tunnel as broken.
 */
async function probe(url: string): Promise<{ up: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    return { up: true, detail: `HTTP ${res.status}` }
  } catch (err) {
    return { up: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Wait for a hostname to exist in DNS, WITHOUT going through the OS resolver.
 *
 * This ordering is load-bearing, and getting it wrong cost an afternoon. A
 * quick tunnel's hostname does not exist for the first ~10s. If anything calls
 * getaddrinfo in that window — fetch, curl, anything — macOS caches the
 * NXDOMAIN for the SOA's negative TTL, and every later lookup is served that
 * cached miss. The tunnel comes up fine and the machine that started it is the
 * one machine that cannot reach it, for minutes, while `dig` cheerfully
 * resolves the name because it queries the nameserver directly.
 *
 * dns.resolve4 goes through c-ares straight to the configured nameservers, so
 * polling with it never populates the OS cache. Only once it answers do we let
 * an HTTP request (and therefore getaddrinfo) anywhere near the name.
 */
async function waitForDns(host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const addrs = await dns.resolve4(host)
      if (addrs.length > 0) return true
    } catch {
      // NXDOMAIN / SERVFAIL while the tunnel registers. Keep waiting.
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

/**
 * Poll until reachable. Returns false instead of throwing on timeout: a tunnel
 * that is slow to propagate is not a reason to tear down a working dev server
 * and make the user start over — print the URL and let them try it.
 */
async function waitUntilUp(url: string, label: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const { up, detail } = await probe(url)
    if (up) return true
    if (detail !== last) {
      last = detail
      const left = Math.round((deadline - Date.now()) / 1000)
      console.log(`[${label}] not reachable yet (${detail}) — retrying for ${left}s`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

const localUrl = `http://127.0.0.1:${PORT}`

// ---------------------------------------------------------------- dev server
if ((await probe(localUrl)).up) {
  console.log(`[dev]    reusing the server already listening on :${PORT}`)
} else {
  console.log(`[dev]    starting next dev on :${PORT} ...`)
  const dev = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(dev)
  pipeWithPrefix(dev, '[dev]   ')
  dev.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev]    exited with code ${code}`)
      shutdown(code ?? 1)
    }
  })
  if (!(await waitUntilUp(localUrl, 'dev', 120_000))) {
    console.error('[dev]    never became reachable — aborting')
    shutdown(1)
  }
  console.log('[dev]    ready')
}

// -------------------------------------------------------------------- tunnel
type Tunnel = { url: string; proc: ChildProcess }

/**
 * ngrok publishes a local API listing its live tunnels. Reading the URL from
 * there beats scraping the agent log: it is structured, it survives log-format
 * changes, and it tells us about a tunnel someone else already started.
 */
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels'

async function ngrokPublicUrl(): Promise<string | null> {
  try {
    const res = await fetch(NGROK_API, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const body = (await res.json()) as { tunnels?: Array<{ public_url?: string }> }
    const https = body.tunnels?.find((t) => t.public_url?.startsWith('https://'))
    return https?.public_url ?? null
  } catch {
    return null
  }
}

async function startNgrok(): Promise<Tunnel | null> {
  // Reuse an agent that is already running — a second one would just fail to
  // bind :4040 and leave a confusing error.
  const existing = await ngrokPublicUrl()
  if (existing) {
    console.log(`[tunnel] reusing the ngrok agent already running (${existing})`)
    return { url: existing, proc: { on: () => {}, kill: () => {} } as unknown as ChildProcess }
  }

  const proc = spawn('ngrok', ['http', String(PORT), '--log', 'stdout', '--log-format', 'json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(proc)
  proc.on('error', (err) => {
    console.error('[tunnel] could not start ngrok:', err.message)
    console.error('[tunnel] install it with:  brew install ngrok')
    shutdown(1)
  })

  // Surface the agent's own errors — an expired or missing authtoken is the
  // usual one and it is otherwise silent from here.
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue
    createInterface({ input: stream }).on('line', (line) => {
      if (/"lvl":"(eror|crit)"|ERR_NGROK|authtoken/i.test(line)) {
        console.log(`[tunnel] ${line.trim().slice(0, 300)}`)
      }
    })
  }

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const url = await ngrokPublicUrl()
    if (url) return { url, proc }
    await new Promise((r) => setTimeout(r, 1000))
  }

  console.error('[tunnel] ngrok did not publish a tunnel within 30s.')
  console.error('[tunnel] If this is a fresh machine, run:  ngrok config add-authtoken <token>')
  proc.kill('SIGTERM')
  return null
}

/**
 * Bring up one Cloudflare quick tunnel, or null if this attempt is a dud.
 *
 * Quick tunnels are free and account-less, and sometimes a hostname is handed
 * out that never propagates into DNS — cloudflared says "created" and warns
 * "it may take some time to be reachable", then the name stays NXDOMAIN
 * forever. Observed twice while building this. There is nothing to fix on our
 * side, so the answer is to notice and ask for a different hostname rather
 * than print a dead URL and let someone debug their phone's wifi.
 */
async function startCloudflared(attempt: number): Promise<Tunnel | null> {
  const proc = spawn('cloudflared', ['tunnel', '--url', localUrl, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(proc)
  proc.on('error', (err) => {
    console.error('[tunnel] could not start cloudflared:', err.message)
    console.error('[tunnel] install it with:  brew install cloudflared')
    shutdown(1)
  })

  let url: string
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('cloudflared never printed a tunnel URL')),
        60_000,
      )
      let resolved = false
      for (const stream of [proc.stdout, proc.stderr]) {
        if (!stream) continue
        createInterface({ input: stream }).on('line', (line) => {
          const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
          if (match && !resolved) {
            resolved = true
            clearTimeout(timer)
            resolve(match[0])
            return
          }
          if (resolved && /\bERR\b|error=|failed/i.test(line)) {
            console.log(`[tunnel] ${line.trim()}`)
          }
        })
      }
    })
  } catch (err) {
    console.error(`[tunnel] ${err instanceof Error ? err.message : err}`)
    proc.kill('SIGTERM')
    return null
  }

  console.log(`[tunnel] attempt ${attempt}: ${url}`)

  // DNS first, over c-ares — see waitForDns. Never fetch before this returns.
  if (await waitForDns(new URL(url).hostname, 90_000)) {
    if (await waitUntilUp(url, 'tunnel', 60_000)) return { url, proc }
  } else {
    console.log('[tunnel] hostname never appeared in DNS')
  }

  console.log('[tunnel] that hostname never came up (Cloudflare hands out a dud')
  console.log('[tunnel] every so often) — asking for a fresh one')
  proc.kill('SIGTERM')
  return null
}

console.log(`[tunnel] starting ${PROVIDER} ...`)
let tunnel: Tunnel | null = null
if (PROVIDER === 'ngrok') {
  tunnel = await startNgrok()
} else {
  for (let attempt = 1; attempt <= 3 && !tunnel; attempt++) {
    tunnel = await startCloudflared(attempt)
  }
  if (!tunnel) {
    console.error('[tunnel] three quick tunnels in a row failed to become reachable.')
    console.error('[tunnel] Try `npm run dev:phone` again, or drop the --cloudflared flag.')
  }
}
if (!tunnel) {
  shutdown(1)
  throw new Error('unreachable')
}
const publicUrl = tunnel.url
console.log(`[tunnel] up at ${publicUrl}`)

// A tunnel that dies mid-session takes the phone with it, and the symptom on
// the phone is an unexplained timeout. Say so here instead.
tunnel.proc.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[tunnel] the tunnel exited (code ${code}) — the phone URL is dead now`)
    shutdown(code ?? 1)
  }
})

// -------------------------------------------------------------------- worker
if (WITH_WORKER) {
  console.log('[worker] starting drain + reconcile loop (every 5s)')
  const worker = spawn('npx', ['tsx', 'scripts/worker.mts', '--watch'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(worker)
  pipeWithPrefix(worker, '[worker]')
}

// ------------------------------------------------------------------ the panel
const line = '─'.repeat(66)
console.log(`
┌${line}┐
  REGAL LAB — phone test session

  Open on the LAPTOP (this is the one that matters — the QR copies
  whatever origin you load the terminal on):

      ${publicUrl}/staff/terminal

  The phone just scans the QR. Sign in there with a DIFFERENT account
  than the terminal if you want a realistic customer.

  Pick "Test Item (₹1)" and hit Create order.
${
  PROVIDER === 'ngrok'
    ? `
  NOTE — ngrok free shows a "You are about to visit ..." page the first
  time each device opens this URL. Tap "Visit Site" once, on the laptop
  and again on the phone after scanning. It is remembered by cookie for
  the rest of the session and does not affect the payment flow.
`
    : ''
}
  Other pages:
      ${publicUrl}/checkout          self-checkout
      ${publicUrl}/orders            customer order history
      ${publicUrl}/staff/orders      staff lookup + refunds

  Razorpay webhook (optional — the confirm route and the reconciler
  already settle payments without it). To wire it anyway, set this in
  the Razorpay test dashboard, Settings -> Webhooks:

      ${publicUrl}/api/webhooks/razorpay

  Test-mode payment: use NETBANKING and pick any bank -> Success.
  Test cards reject small amounts and UPI may be off on the account.

  Ctrl-C stops the tunnel, the dev server and the worker.
└${line}┘
`)
