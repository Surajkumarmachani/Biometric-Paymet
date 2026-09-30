import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth, reverificationError } from '@clerk/nextjs/server'
import { requireStaff, REVERIFY_CONFIG } from '@/lib/auth'
import { enforce } from '@/lib/rate-limit'
import { errorResponse, newRequestId, fail } from '@/lib/errors'
import { readJson } from '@/lib/body'
import { requireApiKey } from '@/lib/api-keys'
import { alertOn } from '@/lib/audit'
import { findUserByEmail, setStaffAccess, teamRefusal } from '@/lib/team'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Grant or change someone's staff access. Admins only.
 *
 * Access decides who can move money (managers refund their store; admins
 * refund anything and hand out access), so this carries the same weight as a
 * refund: admin role, a fresh passkey step-up, a rate limit, and an alert on
 * every change. The rules themselves — never your own access, never zero
 * admins, audit row — are enforced in app.admin_set_staff (0020), not here.
 *
 * Identify the person by `email` (adding someone new) or `clerkId` (changing a
 * row already on the Team page).
 */
const Body = z
  .object({
    email: z.string().email().max(254).optional(),
    clerkId: z.string().regex(/^user_[A-Za-z0-9]+$/).max(64).optional(),
    role: z.enum(['associate', 'manager', 'admin']),
    storeId: z.string().uuid(),
    active: z.boolean(),
  })
  .refine((b) => !!b.email !== !!b.clerkId, { message: 'send exactly one of email or clerkId' })

export async function POST(request: Request) {
  const requestId = newRequestId()
  try {
    await requireApiKey(request)
    // Role first: a non-admin gets a flat 403, not a pointless step-up prompt.
    const admin = await requireStaff('admin')

    const a = await auth()
    if (!a.has({ reverification: REVERIFY_CONFIG })) {
      return NextResponse.json(reverificationError(REVERIFY_CONFIG), { status: 403 })
    }

    await enforce('staffAdminPerUser', admin.userId)

    const parsed = Body.safeParse(await readJson(request))
    if (!parsed.success) fail('invalid_request', parsed.error.message)
    const { email, clerkId, role, storeId, active } = parsed.data

    const target = clerkId ? { clerkId } : await findUserByEmail(email!)
    const result = await setStaffAccess({
      actorId: admin.userId,
      targetId: target.clerkId,
      storeId,
      role,
      active,
    })

    alertOn('staff_access_changed', {
      actor: admin.userId,
      target: result.clerkId,
      role: result.role,
      active: result.active,
      created: result.created,
    })

    return NextResponse.json({ ...result, requestId })
  } catch (err) {
    const refusal = teamRefusal(err)
    if (refusal) {
      const status = /admin|own access/i.test(refusal) ? 403 : /account|signed in/i.test(refusal) ? 404 : 400
      console.warn(JSON.stringify({ level: 'warn', event: 'staff_access_refused', reason: refusal, requestId }))
      return NextResponse.json({ error: { code: 'refused', message: refusal }, requestId }, { status })
    }
    return errorResponse(err, requestId)
  }
}
