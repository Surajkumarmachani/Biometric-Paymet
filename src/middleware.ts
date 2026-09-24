import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

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
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    // Host allowlist stays effective (no 'strict-dynamic'), so Razorpay Checkout
    // and clerk-js keep loading; the nonce covers Next/Clerk inline scripts.
    // challenges.cloudflare.com is Clerk's bot-protection CAPTCHA (Turnstile).
    `script-src 'self' 'nonce-${nonce}' https://checkout.razorpay.com https://*.clerk.accounts.dev https://challenges.cloudflare.com${isDev ? " 'unsafe-eval'" : ""}`,
    "frame-src https://api.razorpay.com https://checkout.razorpay.com https://*.clerk.accounts.dev https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://*.supabase.co wss://*.supabase.co https://*.clerk.accounts.dev https://challenges.cloudflare.com",
    "img-src 'self' data: https://cdn.razorpay.com https://img.clerk.com https://*.clerk.accounts.dev",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export default clerkMiddleware(async (_auth, request) => {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = contentSecurityPolicy(nonce);

  // Next reads the nonce from the request-side CSP header and stamps it onto its
  // own inline scripts; Clerk's <ClerkProvider> picks it up the same way.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
