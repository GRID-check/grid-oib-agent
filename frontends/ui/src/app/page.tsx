/**
 * Home Page
 *
 * Thin redirect, no UI: authenticated users go to the project workspace,
 * logged-out visitors go to the public landing site (GRID_LANDING_URL — the
 * Astro marketing/blog microservice). When GRID_LANDING_URL is unset (local
 * dev without the landing service) the fallback is WorkOS sign-in, and with
 * REQUIRE_AUTH off (dev) we skip auth entirely.
 *
 * `?sign-in` opts out of the landing bounce and goes to WorkOS instead. It is
 * load-bearing, not a convenience: the landing site's only link back here is
 * its "Anmelden"/"Sign in" button, so without an intent marker that button
 * lands on the very redirect that sends the visitor back to the landing site
 * — a closed loop with no way into the app. The app owns the sign-in entry
 * point; the marketing site just points at it.
 */

import { redirect } from 'next/navigation'
import { isAuthRequired } from '@/lib/auth/auth-required'
import { getGridSession } from '@/lib/auth/session'
import { runWithTenantSlot } from '@/lib/db/tenant-context'

/**
 * The sign-in entry route. getSignInUrl() must NOT be called here: it writes
 * the PKCE cookie via cookies().set(), which Next.js forbids during Server
 * Component rendering (only Server Functions and Route Handlers may set
 * cookies) — calling it inside this render threw on every /?sign-in visit.
 * The Route Handler runs where cookie mutation is legal and forwards to WorkOS.
 */
const SIGN_IN_ROUTE = '/api/auth/signin'

interface HomePageProps {
  searchParams: Promise<{ 'sign-in'?: string | string[] }>
}

export default async function HomePage({ searchParams }: HomePageProps): Promise<never> {
  return runWithTenantSlot(async () => {
    if (isAuthRequired()) {
      const session = await getGridSession()
      if (!session) {
        // Resolve before redirect() — it throws to unwind the render.
        const wantsSignIn = 'sign-in' in (await searchParams)
        const landingUrl = process.env.GRID_LANDING_URL
        redirect(wantsSignIn || !landingUrl ? SIGN_IN_ROUTE : landingUrl)
      }
    }
    redirect('/app/projects')
  })
}
