/**
 * Home Page
 *
 * Thin redirect, no UI: authenticated users go to the project workspace,
 * logged-out visitors go to the public landing site (GRID_LANDING_URL — the
 * Astro marketing/blog microservice). When GRID_LANDING_URL is unset (local
 * dev without the landing service) the fallback is WorkOS sign-in, and with
 * REQUIRE_AUTH off (dev) we skip auth entirely.
 */

import { getSignInUrl } from '@workos-inc/authkit-nextjs'
import { redirect } from 'next/navigation'
import { isAuthRequired } from '@/lib/auth/auth-required'
import { getGridSession } from '@/lib/auth/session'

export default async function HomePage(): Promise<never> {
  if (isAuthRequired()) {
    const session = await getGridSession()
    if (!session) {
      const landingUrl = process.env.GRID_LANDING_URL
      redirect(landingUrl || (await getSignInUrl()))
    }
  }
  redirect('/app/projects')
}
