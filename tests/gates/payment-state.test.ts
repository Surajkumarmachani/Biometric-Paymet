import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, paise, ALICE, idem, type TestDb } from '../setup/pg'

/**
 * Gate: PAYMENT STATE — the §7 invariants.
 *
 * These are the ones that lose money when they are wrong:
 *   1. `paid` is never demoted by a late or out-of-order failure
 *   2. `abandoned` is NOT terminal — a late UPI capture must flip it to paid
 *   3. fulfilment fires exactly once per order, ever
 *   4. a captured amount that does not match the order is refused outright
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('paystate') })
afterAll(async () => { await db?.drop() })

interface ApplyResult {
  order_id: string
  previous_status: string
  status: string
  fulfil_now: boolean
  late_authorisation: boolean
  receipt_no: string | null
  amount_captured_paise: string
}

let seq = 0
async function readyOrder(sku = 'RL-CUFF-01'): Promise<{
  id: string
  amount: number
  rzp: string
}> {
  seq += 1
  const out = one<{ order_id: string; amount_paise: string }>(
    await db.sql`select app.create_order(${ALICE},
      ${db.sql.json([{ sku, qty: 1 }])}::jsonb, ${idem('ps')})`,
  )
  const id = out.order_id
  const amount = Number(out.amount_paise)
  const rzp = `order_RZP_${seq}`

  one(await db.sql`
    select app.record_authorization(${id}::uuid, 'clerk_reverification',
      ${`rev_${seq}`}, ${ALICE}, ${amount})
  `)
  one(await db.sql`select app.attach_razorpay_order(${id}::uuid, ${rzp})`)
  return { id, amount, rzp }
}

function apply(args: {
  rzp: string
  paymentId: string
  status: string
  amount: number
  currency?: string
  method?: string
}) {
  return db.sql`
    select app.apply_payment_event(
      ${args.rzp}, ${args.paymentId}, ${args.status},
      ${args.amount}, ${args.currency ?? 'INR'}, ${args.method ?? 'upi'}
    )
  `
}

describe('capture', () => {
  it('marks paid, issues a receipt and fulfils exactly once', async () => {
    const o = await readyOrder()
    const r = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_1', status: 'captured', amount: o.amount }),
    )

    expect(r.status).toBe('paid')
    expect(r.fulfil_now).toBe(true)
    expect(r.receipt_no).toMatch(/^RL-\d{4}-\d{6}$/)
    expect(paise(r.amount_captured_paise)).toBe(o.amount)
  })

  it('payment.captured and order.paid co-firing fulfils only once', async () => {
    const o = await readyOrder()

    // Both events carry the SAME payment id — this is what Razorpay actually does.
    const first = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_2', status: 'captured', amount: o.amount }),
    )
    const second = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_2', status: 'captured', amount: o.amount }),
    )

    expect(first.fulfil_now).toBe(true)
    expect(second.fulfil_now).toBe(false)
    expect(second.status).toBe('paid')
    // The receipt number must not change on the second pass.
    expect(second.receipt_no).toBe(first.receipt_no)
  })

  it('a redelivered webhook does not double-fulfil', async () => {
    const o = await readyOrder()
    const results: ApplyResult[] = []
    for (let i = 0; i < 5; i++) {
      results.push(
        one<ApplyResult>(
          await apply({ rzp: o.rzp, paymentId: 'pay_3', status: 'captured', amount: o.amount }),
        ),
      )
    }
    expect(results.filter((r) => r.fulfil_now).length).toBe(1)
  })

  it('refuses a captured amount that does not match the order', async () => {
    const o = await readyOrder()
    await expect(
      apply({ rzp: o.rzp, paymentId: 'pay_4', status: 'captured', amount: 1 }),
    ).rejects.toThrow(/does not match order/)
  })

  it('refuses a captured payment in the wrong currency', async () => {
    const o = await readyOrder()
    await expect(
      apply({
        rzp: o.rzp,
        paymentId: 'pay_5',
        status: 'captured',
        amount: o.amount,
        currency: 'USD',
      }),
    ).rejects.toThrow(/does not match order/)
  })

  it('refuses an event for an unknown razorpay order', async () => {
    await expect(
      apply({ rzp: 'order_DOES_NOT_EXIST', paymentId: 'pay_6', status: 'captured', amount: 100 }),
    ).rejects.toThrow(/no order for razorpay_order_id/)
  })
})

describe('failure and retry', () => {
  it('marks payment_failed when every attempt has failed', async () => {
    const o = await readyOrder()
    const r = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_f1', status: 'failed', amount: o.amount }),
    )
    expect(r.status).toBe('payment_failed')
    expect(r.fulfil_now).toBe(false)
  })

  it('INVARIANT 1: a stale failure never demotes a paid order', async () => {
    const o = await readyOrder()

    // Attempt 1 fails, attempt 2 captures.
    one(await apply({ rzp: o.rzp, paymentId: 'pay_a1', status: 'failed', amount: o.amount }))
    const captured = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_a2', status: 'captured', amount: o.amount }),
    )
    expect(captured.status).toBe('paid')

    // Now attempt 1's payment.failed webhook arrives LATE and OUT OF ORDER.
    const late = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_a1', status: 'failed', amount: o.amount }),
    )

    expect(late.status).toBe('paid')       // ← the v2 defect: this flipped to failed
    expect(late.fulfil_now).toBe(false)    // and must not re-fulfil
  })

  it('capture wins regardless of the order events arrive in', async () => {
    const o = await readyOrder()
    // Capture first, THEN a failure for a different attempt.
    one(await apply({ rzp: o.rzp, paymentId: 'pay_b1', status: 'captured', amount: o.amount }))
    const r = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_b2', status: 'failed', amount: o.amount }),
    )
    expect(r.status).toBe('paid')
  })

  it('keeps the order open while an attempt is still authorized', async () => {
    const o = await readyOrder()
    const r = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_c1', status: 'authorized', amount: o.amount }),
    )
    expect(r.status).toBe('awaiting_payment')
  })
})

describe('INVARIANT 2: abandoned is not terminal', () => {
  it('a late UPI capture flips an abandoned order to paid and flags it', async () => {
    const o = await readyOrder()
    // The reconciler gave up.
    await db.sql`update orders set status = 'abandoned' where id = ${o.id}::uuid`

    const r = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_late', status: 'captured', amount: o.amount }),
    )

    expect(r.previous_status).toBe('abandoned')
    expect(r.status).toBe('paid')
    expect(r.late_authorisation).toBe(true)  // ← must alert: customer WAS charged
    expect(r.fulfil_now).toBe(true)
  })
})

describe('refunds', () => {
  async function paidOrder() {
    const o = await readyOrder()
    one(await apply({ rzp: o.rzp, paymentId: `pay_r_${seq}`, status: 'captured', amount: o.amount }))
    return { ...o, paymentId: `pay_r_${seq}` }
  }

  it('INVARIANT 4: a partial refund does NOT change status', async () => {
    const o = await paidOrder()
    const r = one<{ amount_refunded_paise: string; fully_refunded: boolean }>(
      await db.sql`
        select app.apply_refund(${o.paymentId}, ${'rfnd_p1'}, ${1000}, ${'processed'})
      `,
    )
    expect(r.fully_refunded).toBe(false)
    expect(paise(r.amount_refunded_paise)).toBe(1000)

    const rows = (await db.sql`
      select status, amount_refunded_paise from orders where id = ${o.id}::uuid
    `) as unknown as Array<{ status: string; amount_refunded_paise: string }>
    expect(rows[0]!.status).toBe('paid')
    expect(paise(rows[0]!.amount_refunded_paise)).toBe(1000)
  })

  it('a full refund moves the order to refunded', async () => {
    const o = await paidOrder()
    const r = one<{ fully_refunded: boolean }>(
      await db.sql`
        select app.apply_refund(${o.paymentId}, ${'rfnd_f1'}, ${o.amount}, ${'processed'})
      `,
    )
    expect(r.fully_refunded).toBe(true)

    const rows = (await db.sql`
      select status from orders where id = ${o.id}::uuid
    `) as unknown as Array<{ status: string }>
    expect(rows[0]!.status).toBe('refunded')
  })

  it('a full refund does NOT demote a charged_back order (post-paid sticky)', async () => {
    const o = await paidOrder()
    // Lose a dispute -> charged_back (the bank clawed the money back).
    one(await db.sql`select app.apply_dispute(${o.paymentId}, ${'disp_cb'}, ${'lost'})`)
    let rows = (await db.sql`select status from orders where id = ${o.id}::uuid`) as unknown as Array<{ status: string }>
    expect(rows[0]!.status).toBe('charged_back')

    // A full refund recorded afterward must record the amount but NOT relabel it.
    await db.sql`select app.apply_refund(${o.paymentId}, ${'rfnd_cb'}, ${o.amount}, ${'processed'})`
    rows = (await db.sql`select status, amount_refunded_paise from orders where id = ${o.id}::uuid`) as unknown as Array<{ status: string; amount_refunded_paise: string }>
    expect(rows[0]!.status).toBe('charged_back')
    expect(paise((rows[0] as unknown as { amount_refunded_paise: string }).amount_refunded_paise)).toBe(o.amount)
  })

  it('is idempotent on the refund id — a redelivered webhook cannot double-refund', async () => {
    const o = await paidOrder()
    for (let i = 0; i < 3; i++) {
      await db.sql`select app.apply_refund(${o.paymentId}, ${'rfnd_i1'}, ${5000}, ${'processed'})`
    }
    const rows = (await db.sql`
      select amount_refunded_paise from orders where id = ${o.id}::uuid
    `) as unknown as Array<{ amount_refunded_paise: string }>
    // Recomputed as a SUM over refunds, not incremented.
    expect(paise(rows[0]!.amount_refunded_paise)).toBe(5000)
  })

  it('never lets refunds exceed what was captured', async () => {
    const o = await paidOrder()
    await expect(
      db.sql`select app.apply_refund(${o.paymentId}, ${'rfnd_x1'}, ${o.amount * 2}, ${'processed'})`,
    ).rejects.toThrow() // refund_within_capture check constraint
  })
})

describe('disputes', () => {
  async function paidOrder(tag: string) {
    const o = await readyOrder()
    const paymentId = `pay_d_${tag}`
    one(await apply({ rzp: o.rzp, paymentId, status: 'captured', amount: o.amount }))
    return { ...o, paymentId }
  }

  it('created -> disputed, lost -> charged_back, won -> paid', async () => {
    const o = await paidOrder('1')

    let r = one<{ status: string }>(
      await db.sql`select app.apply_dispute(${o.paymentId}, ${'disp_1'}, ${'created'})`,
    )
    expect(r.status).toBe('disputed')

    r = one<{ status: string }>(
      await db.sql`select app.apply_dispute(${o.paymentId}, ${'disp_1'}, ${'lost'})`,
    )
    expect(r.status).toBe('charged_back')

    r = one<{ status: string }>(
      await db.sql`select app.apply_dispute(${o.paymentId}, ${'disp_1'}, ${'won'})`,
    )
    expect(r.status).toBe('paid')
  })

  it('a post-paid state is sticky against further payment events', async () => {
    const o = await paidOrder('2')
    one(await db.sql`select app.apply_dispute(${o.paymentId}, ${'disp_2'}, ${'created'})`)

    // A redelivered payment.captured must not silently clear the dispute.
    const r = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: o.paymentId, status: 'captured', amount: o.amount }),
    )
    expect(r.status).toBe('disputed')
  })
})

describe('reconciler schedule', () => {
  it('backs off 10s, 20s, 40s, 60s, 120s then 60s', async () => {
    const rows = (await db.sql`
      select app.next_poll_delay(g)::text as d from generate_series(0, 5) g
    `) as unknown as Array<{ d: string }>
    expect(rows.map((r) => r.d)).toEqual([
      '00:00:10', '00:00:20', '00:00:40', '00:01:00', '00:02:00', '00:01:00',
    ])
  })

  it('abandons an order past the 15-minute wall but keeps an hourly heartbeat', async () => {
    const o = await readyOrder()
    await db.sql`
      update orders set awaiting_since = now() - interval '16 minutes',
                        next_poll_at   = now() - interval '1 second'
       where id = ${o.id}::uuid
    `

    const rows = (await db.sql`select * from app.claim_due_orders(10)`) as unknown as Array<{
      order_id: string
      status: string
    }>
    expect(rows.find((r) => r.order_id === o.id)?.status).toBe('abandoned')

    const after = (await db.sql`
      select status, next_poll_at > now() + interval '50 minutes' as hourly
        from orders where id = ${o.id}::uuid
    `) as unknown as Array<{ status: string; hourly: boolean }>

    expect(after[0]!.status).toBe('abandoned')
    // Still polling — this is what catches a late authorisation.
    expect(after[0]!.hourly).toBe(true)
  })

  it('stops polling for good after 24 hours', async () => {
    const o = await readyOrder()
    await db.sql`
      update orders set awaiting_since = now() - interval '25 hours',
                        next_poll_at   = now() - interval '1 second'
       where id = ${o.id}::uuid
    `
    await db.sql`select * from app.claim_due_orders(10)`

    const rows = (await db.sql`
      select next_poll_at from orders where id = ${o.id}::uuid
    `) as unknown as Array<{ next_poll_at: string | null }>
    expect(rows[0]!.next_poll_at).toBeNull()
  })

  it('does not hand the same order to two concurrent reconcilers', async () => {
    const o = await readyOrder()
    await db.sql`update orders set next_poll_at = now() - interval '1 second'
                  where id = ${o.id}::uuid`

    const [a, b] = await Promise.all([
      db.sql`select * from app.claim_due_orders(10)`,
      db.sql`select * from app.claim_due_orders(10)`,
    ])
    const seen = [...(a as unknown as Array<{ order_id: string }>),
                  ...(b as unknown as Array<{ order_id: string }>)]
      .filter((r) => r.order_id === o.id)

    expect(seen.length).toBe(1)
  })

  it('stops polling once an order is paid', async () => {
    const o = await readyOrder()
    one(await apply({ rzp: o.rzp, paymentId: 'pay_stop', status: 'captured', amount: o.amount }))
    const rows = (await db.sql`
      select next_poll_at from orders where id = ${o.id}::uuid
    `) as unknown as Array<{ next_poll_at: string | null }>
    expect(rows[0]!.next_poll_at).toBeNull()
  })

  // S5 #3: a UPI collect can confirm late even after an apparent failure.
  it('keeps polling a payment_failed order (late-capture safety net)', async () => {
    const o = await readyOrder()
    const r = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_pf1', status: 'failed', amount: o.amount }),
    )
    expect(r.status).toBe('payment_failed')
    const rows = (await db.sql`
      select next_poll_at from orders where id = ${o.id}::uuid
    `) as unknown as Array<{ next_poll_at: string | null }>
    expect(rows[0]!.next_poll_at).not.toBeNull() // previously null → dropped from polling
  })

  it('the reconciler claims a due payment_failed order', async () => {
    const o = await readyOrder()
    one(await apply({ rzp: o.rzp, paymentId: 'pay_pf2', status: 'failed', amount: o.amount }))
    await db.sql`update orders set next_poll_at = now() - interval '1 second' where id = ${o.id}::uuid`
    const claimed = (await db.sql`select order_id from app.claim_due_orders(10)`) as unknown as Array<{ order_id: string }>
    expect(claimed.some((r) => r.order_id === o.id)).toBe(true)
  })

  it('a late capture flips a payment_failed order to paid and flags it', async () => {
    const o = await readyOrder()
    one(await apply({ rzp: o.rzp, paymentId: 'pay_pf3a', status: 'failed', amount: o.amount }))
    const r = one<ApplyResult>(
      await apply({ rzp: o.rzp, paymentId: 'pay_pf3b', status: 'captured', amount: o.amount }),
    )
    expect(r.previous_status).toBe('payment_failed')
    expect(r.status).toBe('paid')
    expect(r.late_authorisation).toBe(true) // customer WAS charged on a failed order
    expect(r.fulfil_now).toBe(true)
  })

  it('gives up on a payment_failed order after 24h', async () => {
    const o = await readyOrder()
    one(await apply({ rzp: o.rzp, paymentId: 'pay_pf4', status: 'failed', amount: o.amount }))
    await db.sql`
      update orders set awaiting_since = now() - interval '25 hours',
                        next_poll_at   = now() - interval '1 second'
       where id = ${o.id}::uuid
    `
    await db.sql`select * from app.claim_due_orders(10)`
    const rows = (await db.sql`
      select next_poll_at from orders where id = ${o.id}::uuid
    `) as unknown as Array<{ next_poll_at: string | null }>
    expect(rows[0]!.next_poll_at).toBeNull()
  })
})

describe('webhook ledger', () => {
  async function enqueue(eventId: string, type = 'payment.captured') {
    await db.sql`
      insert into razorpay_webhook_events
        (event_id, event_type, razorpay_created_at, payload)
      values (${eventId}, ${type}, now(), ${'{"event":"x"}'}::jsonb)
    `
  }

  it('rejects a duplicate event id', async () => {
    await enqueue('evt_dup')
    await expect(enqueue('evt_dup')).rejects.toThrow()
  })

  it('leases rows so two drains cannot process the same event', async () => {
    await enqueue('evt_lease')
    const [a, b] = await Promise.all([
      db.sql`select * from app.claim_webhook_batch(10)`,
      db.sql`select * from app.claim_webhook_batch(10)`,
    ])
    const seen = [...(a as unknown as Array<{ event_id: string }>),
                  ...(b as unknown as Array<{ event_id: string }>)]
      .filter((r) => r.event_id === 'evt_lease')
    expect(seen.length).toBe(1)
  })

  it('backs off on failure and dead-letters after 8 attempts', async () => {
    await enqueue('evt_dead')
    for (let i = 0; i < 9; i++) {
      await db.sql`select * from app.claim_webhook_batch(50)`
      await db.sql`select app.finish_webhook(${'evt_dead'}, false, ${'boom'})`
      await db.sql`update razorpay_webhook_events set next_attempt_at = now() - interval '1 s'
                    where event_id = ${'evt_dead'}`
    }
    const rows = (await db.sql`
      select status, attempts from razorpay_webhook_events where event_id = ${'evt_dead'}
    `) as unknown as Array<{ status: string; attempts: number }>
    expect(rows[0]!.status).toBe('dead')
  })

  it('purges processed payloads past retention, for DPDP', async () => {
    await enqueue('evt_purge')
    await db.sql`select * from app.claim_webhook_batch(50)`
    await db.sql`select app.finish_webhook(${'evt_purge'}, true)`
    await db.sql`update razorpay_webhook_events
                    set purge_after = now() - interval '1 day'
                  where event_id = ${'evt_purge'}`

    const report = one<{ events_purged: number }>(await db.sql`select app.sweep()`)
    expect(report.events_purged).toBeGreaterThanOrEqual(1)
  })
})
