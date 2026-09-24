'use client'

import { useLayoutEffect, useRef, useState } from 'react'

/**
 * The confirmation amount, counting up to the total that was actually charged.
 *
 * The security constraint shapes the whole component. Everywhere in this app
 * the displayed amount is rendered server-side from the order row and never
 * from a client value — that is the mitigation for "displayed amount != signed
 * amount". So this does NOT compute anything: it is handed the finished string
 * the server already formatted, and every frame it shows is derived from that
 * same string. The number it lands on is the server's, character for character.
 *
 * Progressive enhancement, in this order:
 *   * The server renders `display`. With no JS, that is what stays on screen —
 *     correct, just not animated.
 *   * useLayoutEffect (not useEffect) runs after hydration but BEFORE paint, so
 *     resetting to zero to begin the count never shows as a flash of the final
 *     figure.
 *   * prefers-reduced-motion skips the animation outright rather than running
 *     it fast, because a number scrambling for even 200ms is exactly what that
 *     setting exists to prevent.
 */
export default function CountUpAmount({
  display,
  paise,
  className,
}: {
  display: string
  paise: number
  className?: string
}) {
  const [text, setText] = useState(display)
  const frame = useRef<number | null>(null)

  useLayoutEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    // Counting to zero is not a moment worth animating.
    if (reduced || paise <= 0) {
      setText(display)
      return
    }

    // Rebuild each frame's string from the target's own formatting: split off
    // the currency symbol and the decimals, animate only the rupee digits, and
    // regroup them the way the server did. The paise never move, so the string
    // keeps a stable width and the layout does not jitter.
    const symbol = display.startsWith('₹') ? '₹' : ''
    const decimals = display.slice(display.lastIndexOf('.'))
    const targetRupees = Math.floor(paise / 100)

    const group = (n: number): string => {
      const s = String(n)
      return s.length <= 3
        ? s
        : `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`
    }

    const DURATION = 620
    const started = performance.now()
    setText(`${symbol}${group(0)}${decimals}`)

    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / DURATION)
      // Ease-out cubic: fast off the mark, settling into the final figure.
      const eased = 1 - Math.pow(1 - t, 3)
      if (t >= 1) {
        // Land on the server's exact string rather than anything reconstructed
        // here — no rounding of ours can disagree with what was charged.
        setText(display)
        return
      }
      setText(`${symbol}${group(Math.round(targetRupees * eased))}${decimals}`)
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)

    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
    }
  }, [display, paise])

  return (
    <p className={className} style={{ margin: 0 }}>
      {text}
    </p>
  )
}
