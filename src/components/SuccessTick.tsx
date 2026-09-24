/**
 * The paid tick, shared by all three screens in the money path so the moment
 * looks identical wherever you see it — the customer's phone, the confirmation
 * page, and the associate's terminal.
 *
 * SVG rather than a text glyph, which is a deliberate exception to the
 * no-icons rule everywhere else in this app: a tick that draws itself needs
 * stroke-dashoffset, and there is no way to get that from a character. The
 * ring scales in first, the stroke follows 220ms behind — the order matters,
 * because a mark drawn before its container reads as a glitch.
 *
 * Not a client component: it is pure markup and CSS, so it renders on the
 * server and animates on arrival without shipping any JavaScript.
 */
export default function SuccessTick({ size = 56 }: { size?: number }) {
  return (
    <span
      className="tick"
      style={{ width: size, height: size }}
      role="img"
      aria-label="Paid"
    >
      <span className="tick-ring" aria-hidden="true" />
      <svg
        className="tick-mark"
        width={size * 0.5}
        height={size * 0.5}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M4 12.5 L9.5 18 L20 6.5" />
      </svg>
    </span>
  )
}
