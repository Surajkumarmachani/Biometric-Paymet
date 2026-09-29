/**
 * Hosts allowed to hit the dev server's internal endpoints (/_next/*) from a
 * different origin. Next 15 blocks these by default, which breaks the whole
 * point of the in-store flow: the phone reaches the laptop through a tunnel,
 * so every asset request arrives cross-origin and HMR/RSC payloads 403 without
 * this. The wildcards cover a quick tunnel whose hostname is different on
 * every restart; DEV_ALLOWED_ORIGINS is written by scripts/dev-phone.mts for
 * the concrete host, and also lets you add a LAN IP by hand.
 *
 * Dev only — Next ignores this in a production build.
 */
const devAllowedOrigins = [
  '*.trycloudflare.com',
  // ngrok hands out *.ngrok-free.dev today and *.ngrok-free.app / *.ngrok.app
  // historically; a paid account gets *.ngrok.io or a custom domain. Miss the
  // right one and every /_next/* request 403s with "Unauthorized" while the
  // page itself loads fine — a confusing half-broken app rather than an error.
  '*.ngrok-free.dev',
  '*.ngrok-free.app',
  '*.ngrok.app',
  '*.ngrok.io',
  ...(process.env.DEV_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]

/**
 * Build output directory.
 *
 * `next build` and `next dev` both write to `.next` by default, so running a
 * build while the dev server is up replaces the chunks the dev server is still
 * serving from memory. The symptom is vicious: route chunks start 404ing as
 * text/plain, `X-Content-Type-Options: nosniff` makes the browser refuse them,
 * and the page renders its server HTML but never hydrates — so a client
 * component silently disappears. On /pay/[token] that means the customer sees
 * the amount and the items with no button to pay, and nothing in the server
 * log looks wrong.
 *
 * Set NEXT_DIST_DIR to build into somewhere else while dev keeps running:
 *   NEXT_DIST_DIR=.next-build npm run build
 */
/**
 * Resolve the dev port the same way in both processes that load this file.
 *
 * Next evaluates next.config TWICE with different context:
 *   * the CLI process  — argv is ['node','next','dev','-p','3001'], PORT unset
 *   * the server child — argv is ['node','.../start-server.js'], PORT='3001'
 *
 * They must agree, or the CLI and the server pick different build directories
 * and the server quietly falls back to the default. So: prefer PORT (set in
 * the child), fall back to parsing argv (available in the CLI), then 3000.
 */
function devServerPort() {
  if (process.env.PORT) return process.env.PORT
  const argv = process.argv
  const flag = argv.findIndex((a) => a === '-p' || a === '--port')
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1]
  const inline = argv.find((a) => a.startsWith('--port='))
  if (inline) return inline.split('=')[1]
  return '3000'
}

/*
 * Every dev server gets its own build directory, keyed by port.
 *
 * Two `next dev` processes on different ports still share `.next` by default,
 * and they overwrite each other's compiled chunks. The loser then serves
 * chunks that 404 as text/plain; `nosniff` makes the browser refuse them, and
 * the page renders server HTML but never hydrates — buttons dead, client
 * components silently gone, nothing wrong in the log. This cost hours twice:
 * once from `next build` racing dev, once from a second dev server on :3001
 * while the tunnel pointed at :3000.
 *
 * NODE_ENV is the discriminator rather than argv, because it is the one signal
 * that reads the same in both processes above. `next build` sets 'production'
 * and so keeps the plain `.next`.
 */
const distDir =
  process.env.NEXT_DIST_DIR ||
  (process.env.NODE_ENV === 'development' ? `.next-dev-${devServerPort()}` : '.next')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  distDir,

  // The Dockerfile sets NEXT_OUTPUT=standalone so the Cloud Run image carries
  // only the traced server files. Local dev, `next start` and Vercel keep the
  // default output.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),

  allowedDevOrigins: devAllowedOrigins,

  // ZAP 10037: Next sends `X-Powered-By: Next.js` by default, which tells an
  // attacker the framework and narrows their CVE search for free. Nothing needs
  // it. Removing it is not defence in depth, it is just not volunteering.
  poweredByHeader: false,

  // Nothing here uses next/image, so the /_next/image optimiser is pure attack
  // surface: it decodes untrusted AVIF/HEIF through sharp/libvips, which is
  // where Next's image-optimiser RCE advisories live. Unoptimized turns the
  // endpoint off entirely rather than trusting the next patch.
  images: { unoptimized: true },

  // Razorpay's SDK is CommonJS and reaches for node:crypto / axios. Keep it
  // external so the bundler doesn't try to trace it into an edge-ish build.
  serverExternalPackages: ['razorpay', 'postgres', 'qrcode'],

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Content-Security-Policy is set per-request in src/middleware.ts so
          // it can carry a nonce for Next's and Clerk's inline scripts (threat
          // 27 mitigation). The static headers below apply to every response.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // ZAP 10063. Denies browser features this app never uses, so a script
          // that does get injected cannot reach for a camera or a location.
          //
          // READ BEFORE ADDING TO THIS LIST. Two features are deliberately
          // ABSENT, and adding them is how you break the product:
          //   * `payment`  — Razorpay Checkout runs cross-origin and Google/
          //     Apple Pay reach for the Payment Request API
          //   * `publickey-credentials-get` — this is the passkey ceremony
          // Omitting a directive leaves the browser default (`self`) in force,
          // which is exactly the behaviour we already had, so this header
          // changes nothing about how payments or passkeys work. Writing
          // `payment=()` WOULD change it, and would need a live test on every
          // rail before you believed it.
          {
            key: 'Permissions-Policy',
            value: [
              'camera=()',
              'microphone=()',
              'geolocation=()',
              'usb=()',
              'serial=()',
              'bluetooth=()',
              'display-capture=()',
              'magnetometer=()',
              'gyroscope=()',
              'accelerometer=()',
              'idle-detection=()',
            ].join(', '),
          },
        ],
      },
    ]
  },
}

export default nextConfig
