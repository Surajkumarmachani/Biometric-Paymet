import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { authorizedParties, clerkFrontendHost, corsAllowList } from "./lib/edge-config";

const isDev = process.env.NODE_ENV === "development";

/**
 * Per-request nonce CSP. The residual XSS risk in this design is "displayed
 * amount != signed amount" (architecture doc §4.2 / threat 27); a strict
 * script-src is the mitigation. We keep that strictness by nonce-ing Next's and
 * Clerk's inline scripts instead of opening the policy with 'unsafe-inline'.
 *
 * 'unsafe-eval' is added only in development, where Next's HMR / React Refresh
 * runtime evaluates strings. Production never gets it, so the mitigation holds.
 */
// This instance's Clerk host only (see clerkFrontendHost). If the key cannot
// be read, fall back to the dev wildcard rather than break sign-in.
const CLERK = clerkFrontendHost()
const clerkSrc = CLERK ? `https://${CLERK}` : "https://*.clerk.accounts.dev"

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    // Host allowlist stays effective (no 'strict-dynamic'), so Razorpay Checkout
    // and clerk-js keep loading; the nonce covers Next/Clerk inline scripts.
    // challenges.cloudflare.com is Clerk's bot-protection CAPTCHA (Turnstile).
    `script-src 'self' 'nonce-${nonce}' https://checkout.razorpay.com ${clerkSrc} https://challenges.cloudflare.com${isDev ? " 'unsafe-eval'" : ""}`,
    `frame-src https://api.razorpay.com https://checkout.razorpay.com ${clerkSrc} https://challenges.cloudflare.com`,
    "worker-src 'self' blob:",
    `connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://*.supabase.co wss://*.supabase.co ${clerkSrc} https://challenges.cloudflare.com`,
    `img-src 'self' data: https://cdn.razorpay.com https://img.clerk.com ${clerkSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * CORS for /api, so the API can be called from other origins (a desktop app's
 * webview, a customer's site). ALLOWED_ORIGINS is a comma list; "*" allows
 * any origin; unset allows none (same-origin calls never need CORS).
 *
 * Never sends Allow-Credentials, so a foreign page can never ride a signed-in
 * user's Clerk cookie: cross-origin callers authenticate with X-API-Key (and a
 * Bearer session token when a person is involved), not with cookies.
 */
function corsHeaders(origin: string | null): Record<string, string> | null {
  if (!origin) return null
  const { any, origins } = corsAllowList()
  if (!any && !origins.includes(origin)) return null
  return {
    "Access-Control-Allow-Origin": any ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Admin-Token",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  }
}

export default clerkMiddleware(async (_auth, request) => {
  const isApi = request.nextUrl.pathname.startsWith("/api/")
  const cors = isApi ? corsHeaders(request.headers.get("origin")) : null

  // Preflight: answer here; it carries no credentials and must not reach a route.
  if (isApi && request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: cors ?? {} })
  }

  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = contentSecurityPolicy(nonce);

  // Next reads the nonce from the request-side CSP header and stamps it onto its
  // own inline scripts; Clerk's <ClerkProvider> picks it up the same way.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  if (cors) for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
  return response;
}, { authorizedParties: authorizedParties() });

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
