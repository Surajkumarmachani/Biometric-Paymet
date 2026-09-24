import type { ReactNode } from 'react'
import Link from 'next/link'
import { auth } from '@clerk/nextjs/server'
import {
  ClerkProvider,
  SignInButton,
  SignUpButton,
  SignedIn,
  SignedOut,
  UserButton,
} from '@clerk/nextjs'
import { staffRole } from '@/lib/auth'
import './globals.css'

export const metadata = {
  title: 'REGAL LAB — Touchless checkout',
  description: 'Pay in one touch. No forms, no card numbers, no CVV.',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The nav shows the terminal link only to staff. This is presentation only —
  // /staff/terminal and every staff API still gate with requireStaff().
  const { userId } = await auth()
  const role = await staffRole(userId).catch(() => null)

  return (
    <html lang="en">
      <body>
        <ClerkProvider>
          <div className="app-shell">
            <header className="site-header">
              <div className="container site-header-inner">
                <Link href="/" className="brand" aria-label="REGAL LAB home">
                  <span className="brand-mark">REGAL LAB</span>
                  <span className="brand-dot" aria-hidden="true" />
                </Link>

                <nav className="nav">
                  <SignedIn>
                    <Link href="/checkout" className="nav-link">Shop</Link>
                    <Link href="/orders" className="nav-link">Orders</Link>
                    <Link href="/account/security" className="nav-link nav-hide-sm">Security</Link>
                    {role && (
                      <>
                        <Link href="/staff/terminal" className="nav-link gold">Terminal</Link>
                        <Link href="/staff/orders" className="nav-link gold nav-hide-sm">Refunds</Link>
                      </>
                    )}
                    <span className="nav-sep" aria-hidden="true" />
                    <UserButton />
                  </SignedIn>

                  <SignedOut>
                    <SignInButton mode="modal">
                      <button className="btn btn-secondary btn-sm">Sign in</button>
                    </SignInButton>
                    <SignUpButton mode="modal">
                      <button className="btn btn-light btn-sm">Sign up</button>
                    </SignUpButton>
                  </SignedOut>
                </nav>
              </div>
            </header>

            <main className="app-main">{children}</main>

            <footer className="site-footer">
              <div className="container row-between row-wrap">
                <span>REGAL LAB · Touchless biometric checkout</span>
                <span className="mono tiny">Secured by Clerk passkeys &amp; Razorpay</span>
              </div>
            </footer>
          </div>
        </ClerkProvider>
      </body>
    </html>
  )
}
