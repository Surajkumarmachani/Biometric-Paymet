'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import SuccessTick from '@/components/SuccessTick'
import { useAuth } from '@clerk/nextjs'
import { supabaseBrowser, supabaseConfigured } from '@/lib/supabase/browser'
import { apiFetch } from '@/lib/api-client'

/**
 * Live view of one order, over Supabase Realtime.
 *
 * An in-store handover with no ending is not a handover: staff shows the QR, the
 * customer pays on their own phone, and fulfilment happens out of band in the
 * webhook drain — so without a channel back to the terminal the associate is
 * left guessing.
 *
 * Requires `orders` in the supabase_realtime publication (db:reset does this)
 * and the staff_store_orders RLS policy from migration 0005.
 */

const TONE: Record<string, { cls: string; label: string }> = {
  paid:             { cls: 'badge-good badge-tick', label: 'PAID' },
  payment_failed:   { cls: 'badge-danger',  label: 'FAILED' },
  abandoned:        { cls: 'badge-warn',    label: 'ABANDONED' },
  refunded:         { cls: 'badge-neutral', label: 'REFUNDED' },
  disputed:         { cls: 'badge-danger',  label: 'DISPUTED' },
  charged_back:     { cls: 'badge-danger',  label: 'CHARGED BACK' },
}

export default function OrderTile({
  orderId,
  amountDisplay,
  initialStatus,
}: {
  orderId: string
  amountDisplay: string
  initialStatus: string
}) {
  const { getToken } = useAuth()
  const router = useRouter()
  const [status, setStatus] = useState(initialStatus)
  const [receiptNo, setReceiptNo] = useState<string | null>(null)

  useEffect(() => {
    // No Supabase project configured (local-Postgres dev): skip Realtime and
    // let the poll below carry the tile. Throwing here would unmount the tile
    // and take the poll with it.
    if (!supabaseConfigured()) return

    const supabase = supabaseBrowser(() => getToken())

    const channel = supabase
      .channel(`order:${orderId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderId}` },
        (payload) => {
          const row = payload.new as { status?: string; receipt_no?: string | null }
          if (row.status) setStatus(row.status)
          if (row.receipt_no) setReceiptNo(row.receipt_no)
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [orderId, getToken])

  /**
   * Fallback poll. Realtime is the fast path; this is the safety net.
   *
   * Realtime is a single fragile dependency, and its failure mode is silence:
   * a dropped socket, store wifi, a missing `role` claim in the session token,
   * or a table without REPLICA IDENTITY FULL all end the same way — no event,
   * no error, tile reads CLAIMED forever. That is the worst possible lie to
   * tell an associate who is deciding whether to hand over jewellery. Observed
   * live on 2026-08-24: an order captured at 12:56:50 still showed CLAIMED at
   * 12:58:00.
   *
   * So we also ask the server, every 5s, until the order reaches a terminal
   * state. statusPerUser allows 120/min, so 12/min is comfortable. Stops on
   * settle, so a finished tile costs nothing.
   */
  useEffect(() => {
    if (status === 'paid') return

    let cancelled = false
    const poll = async () => {
      try {
        const res = await apiFetch(`/api/orders/${orderId}/status`, { cache: 'no-store' })
        if (!res.ok || cancelled) return
        const data = (await res.json()) as { status?: string; receiptNo?: string | null }
        if (cancelled) return
        if (data.status) setStatus(data.status)
        if (data.receiptNo) setReceiptNo(data.receiptNo)
      } catch {
        // Offline or a blip. The next tick tries again; never surface this as an
        // error, because Realtime may well have delivered the update already.
      }
    }

    const timer = setInterval(poll, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [orderId, status])

  /**
   * When the payment lands, take the terminal to the order.
   *
   * This used to be a link on purpose — a till that navigates away from itself
   * mid-shift loses the next customer's screen. Overridden deliberately: the
   * operator wants the terminal to land on the order the moment it is paid, so
   * both screens end in the same place.
   *
   * `push`, NOT `replace`, and that distinction is the whole safety net here:
   * Back returns to a fresh terminal, so the associate is one gesture from
   * taking the next payment. Prefetch first so the jump is not a visible wait
   * across the counter.
   */
  useEffect(() => {
    if (status !== 'paid') return
    router.prefetch(`/orders/${orderId}`)
    router.push(`/orders/${orderId}`)
  }, [status, orderId, router])

  const tone = TONE[status] ?? {
    cls: 'badge-neutral',
    label: status.replace(/_/g, ' ').toUpperCase(),
  }
  const settled = status === 'paid'

  return (
    <div
      className="card stack-2"
      style={{
        alignItems: 'center',
        textAlign: 'center',
        minWidth: 200,
        borderColor: settled ? 'var(--good-line)' : 'var(--border)',
        background: settled ? 'var(--good-bg)' : 'var(--surface-2)',
      }}
    >
      {settled && <SuccessTick size={52} />}
      <span className="amount-lg">{amountDisplay}</span>
      <span className={`badge ${tone.cls}`}>{tone.label}</span>
      {receiptNo && <span className="tiny faint mono">Receipt {receiptNo}</span>}
      {settled ? (
        <>
          <span className="tiny faint">Opening the order&hellip;</span>
          {/*
            Fallback only — the effect above navigates on the same tick. Same
            tab, so it lands exactly where the automatic jump would, and Back
            still returns to the terminal.
          */}
          <Link href={`/orders/${orderId}`} className="tiny faint">
            Tap here if it doesn&rsquo;t open
          </Link>
        </>
      ) : (
        <span className="tiny faint is-waiting">Updates live — no need to refresh</span>
      )}
    </div>
  )
}
