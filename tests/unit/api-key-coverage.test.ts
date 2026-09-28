import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every /api route must check X-API-Key — except the few that a key cannot
 * reach by construction. This fails the moment someone adds a route and
 * forgets, rather than when a client notices it is wide open.
 */
const EXEMPT: Record<string, string> = {
  'health/route.ts': 'liveness probe, no data',
  'webhooks/razorpay/route.ts': 'Razorpay cannot send our header; HMAC-verified',
  'internal/drain/route.ts': 'cron, INTERNAL_TASK_SECRET',
  'internal/reconcile/route.ts': 'cron, INTERNAL_TASK_SECRET',
  'internal/sweep/route.ts': 'cron, INTERNAL_TASK_SECRET',
  'internal/settlement-recon/route.ts': 'cron, INTERNAL_TASK_SECRET',
  'admin/keys/route.ts': 'ADMIN_TOKEN — mints the first key',
  'admin/keys/[id]/revoke/route.ts': 'ADMIN_TOKEN',
}

const API = join(process.cwd(), 'src', 'app', 'api')

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return routes(p)
    return name === 'route.ts' ? [p] : []
  })
}

describe('api key coverage', () => {
  for (const file of routes(API)) {
    const rel = relative(API, file)
    const src = readFileSync(file, 'utf8')
    const handlers = src.match(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g) ?? []

    if (rel in EXEMPT) {
      it(`${rel} is exempt (${EXEMPT[rel]})`, () => {
        if (rel.startsWith('admin/')) expect(src).toContain('requireAdmin(request)')
      })
      continue
    }

    it(`${rel} checks the API key in every handler`, () => {
      const checks = src.match(/await requireApiKey\(request\)/g) ?? []
      expect(handlers.length).toBeGreaterThan(0)
      expect(checks.length).toBe(handlers.length)
    })
  }
})
