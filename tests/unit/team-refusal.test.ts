import { describe, it, expect } from 'vitest'
import { teamRefusal } from '../../src/lib/team'

/**
 * Unit: the Team page shows WHY a change was refused, but only for the
 * refusals we raise on purpose — never a raw database or driver error.
 */
describe('teamRefusal', () => {
  it('translates the deliberate refusals', () => {
    expect(teamRefusal(new Error('you cannot change your own access; ask another admin'))).toMatch(/your own access/)
    expect(teamRefusal(new Error('there must always be at least one active admin'))).toMatch(/at least one active admin/)
    expect(teamRefusal(new Error('unknown user: they must sign in to the site once first'))).toMatch(/signed in/)
    expect(teamRefusal(new Error('no account with that email: ask them to sign up on the site first'))).toMatch(/sign up/)
  })

  it('passes nothing else through', () => {
    expect(teamRefusal(new Error('duplicate key value violates unique constraint "staff_pkey"'))).toBeNull()
    expect(teamRefusal(new Error('connect ECONNREFUSED 10.0.0.5:5432'))).toBeNull()
    expect(teamRefusal('something else')).toBeNull()
  })
})
