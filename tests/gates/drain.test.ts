import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, one, paise, ALICE, idem, type TestDb } from '../setup/pg'

/**
 * Gate: WEBHOOK LEDGER PAYLOAD SHAPE and event routing.
 *
 * The drain navigates payload.payload.payment.entity.id. If the ledger stores
 * the payload as a jsonb *string* instead of an object — which is exactly what
 * `${rawBody}::jsonb` does under postgres.js — that path silently resolves to
 * undefined, every event fails to route, and NO ORDER IS EVER FULFILLED while
 * the webhook endpoint happily returns 200.
 *
 * These tests pin the shape at the database boundary so the bug cannot come back.
 */

let db: TestDb
beforeAll(async () => { db = await createTestDb('drain') })
afterAll(async () => { await db?.drop() })

const CAPTURED_EVENT = {
  event: 'payment.captured',
  created_at: 1_755_000_000,
  payload: {
    payment: {
      entity: {
        id: 'pay_LEDGER_1',
        order_id: 'order_LEDGER_1',
        status: 'captured',
        amount: 4_500_000,
        currency: 'INR',
        method: 'upi',
      },
    },
  },
}

describe('ledger payload shape', () => {
  it('stores the payload as a jsonb OBJECT, navigable by the drain', async () => {
    await db.sql`
      insert into razorpay_webhook_events
        (event_id, event_type, razorpay_created_at, payload)
      values (
        ${'evt_shape_ok'}, ${CAPTURED_EVENT.event},
        ${new Date(CAPTURED_EVENT.created_at * 1000).toISOString()},
        ${db.sql.json(CAPTURED_EVENT)}::jsonb
      )
    `

    const rows = (await db.sql`
      select jsonb_typeof(payload)                              as top_type,
             payload -> 'payload' -> 'payment' -> 'entity' ->> 'id' as payment_id
        from razorpay_webhook_events where event_id = ${'evt_shape_ok'}
    `) as unknown as Array<{ top_type: string; payment_id: string | null }>

    expect(rows[0]!.top_type).toBe('object')
    expect(rows[0]!.payment_id).toBe('pay_LEDGER_1')
  })

  it('DEMONSTRATES the bug: a raw string payload makes the drain path vanish', async () => {
    const raw = JSON.stringify(CAPTURED_EVENT)

    // This is what `${raw}::jsonb` produces under postgres.js.
    await db.sql`
      insert into razorpay_webhook_events
        (event_id, event_type, razorpay_created_at, payload)
      values (
        ${'evt_shape_bad'}, ${CAPTURED_EVENT.event}, now(), ${raw}::jsonb
      )
    `

    const rows = (await db.sql`
      select jsonb_typeof(payload)                              as top_type,
             payload -> 'payload' -> 'payment' -> 'entity' ->> 'id' as payment_id
        from razorpay_webhook_events where event_id = ${'evt_shape_bad'}
    `) as unknown as Array<{ top_type: string; payment_id: string | null }>

    // A jsonb string, not an object — and the id the drain needs is gone.
    expect(rows[0]!.top_type).toBe('string')
    expect(rows[0]!.payment_id).toBeNull()
  })

  it('a payload with no payment id is detectable rather than silently ignored', async () => {
    await db.sql`
      insert into razorpay_webhook_events
        (event_id, event_type, razorpay_created_at, payload)
      values (${'evt_no_payment'}, ${'order.paid'}, now(),
              ${db.sql.json({ event: 'order.paid', payload: { order: { entity: { id: 'order_X' } } } })}::jsonb)
    `

    const rows = (await db.sql`
      select payload -> 'payload' -> 'payment' -> 'entity' ->> 'id' as payment_id,
             payload -> 'payload' -> 'order'   -> 'entity' ->> 'id' as order_id
        from razorpay_webhook_events where event_id = ${'evt_no_payment'}
    `) as unknown as Array<{ payment_id: string | null; order_id: string | null }>

    // The drain falls back to reconciling the whole order in this case.
    expect(rows[0]!.payment_id).toBeNull()
    expect(rows[0]!.order_id).toBe('order_X')
  })
})

describe('end-to-end through the ledger', () => {
  it('an enqueued capture event resolves the order to paid exactly once', async () => {
    // Build a real order and attach a Razorpay order id.
    const created = one<{ order_id: string; amount_paise: number }>(
      await db.sql`select app.create_order(${ALICE},
        ${db.sql.json([{ sku: 'RL-CUFF-01', qty: 1 }])}::jsonb, ${idem('drain')})`,
    )
    const amount = paise(created.amount_paise)

    one(await db.sql`
      select app.record_authorization(${created.order_id}::uuid, 'clerk_reverification',
        ${'rev_drain'}, ${ALICE}, ${amount})
    `)
    one(await db.sql`
      select app.attach_razorpay_order(${created.order_id}::uuid, ${'order_DRAIN_1'})
    `)

    // Enqueue the event the way the webhook route does.
    const event = {
      event: 'payment.captured',
      created_at: 1_755_000_100,
      payload: {
        payment: {
          entity: {
            id: 'pay_DRAIN_1',
            order_id: 'order_DRAIN_1',
            status: 'captured',
            amount,
            currency: 'INR',
            method: 'upi',
          },
        },
      },
    }
    await db.sql`
      insert into razorpay_webhook_events
        (event_id, event_type, razorpay_created_at, payload)
      values (${'evt_drain_1'}, ${event.event},
              ${new Date(event.created_at * 1000).toISOString()},
              ${db.sql.json(event)}::jsonb)
    `

    // The drain leases the row...
    const leased = (await db.sql`
      select * from app.claim_webhook_batch(10)
    `) as unknown as Array<{ event_id: string; payload: typeof event }>
    const row = leased.find((r) => r.event_id === 'evt_drain_1')
    expect(row).toBeDefined()

    // ...reads the payment id out of the payload (this is the line that breaks
    // if the payload was stored as a string)...
    const paymentId = (row!.payload as unknown as { payload: { payment: { entity: { id: string } } } })
      .payload.payment.entity.id
    expect(paymentId).toBe('pay_DRAIN_1')

    // ...and applies truth re-read from the API.
    const applied = one<{ status: string; fulfil_now: boolean }>(
      await db.sql`
        select app.apply_payment_event(
          ${'order_DRAIN_1'}, ${paymentId}, ${'captured'},
          ${amount}, ${'INR'}, ${'upi'}
        )
      `,
    )
    expect(applied.status).toBe('paid')
    expect(applied.fulfil_now).toBe(true)

    await db.sql`select app.finish_webhook(${'evt_drain_1'}, true)`

    // A redelivery of the same event must not fulfil again.
    const again = one<{ fulfil_now: boolean }>(
      await db.sql`
        select app.apply_payment_event(
          ${'order_DRAIN_1'}, ${paymentId}, ${'captured'},
          ${amount}, ${'INR'}, ${'upi'}
        )
      `,
    )
    expect(again.fulfil_now).toBe(false)

    const finished = (await db.sql`
      select status from razorpay_webhook_events where event_id = ${'evt_drain_1'}
    `) as unknown as Array<{ status: string }>
    expect(finished[0]!.status).toBe('processed')
  })
})
