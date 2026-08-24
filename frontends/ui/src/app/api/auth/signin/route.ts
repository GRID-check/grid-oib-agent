import { getSignInUrl } from '@workos-inc/authkit-nextjs'
import { NextResponse } from 'next/server'
import { tenantSlotRoute } from '@/lib/db/tenant-context'

/**
 * Sign-in entry point.
 *
 * `getSignInUrl()` seals the PKCE state and writes it as a cookie via
 * `cookies().set()` — which Next.js allows ONLY in a Server Function or a
 * Route Handler, never during Server Component rendering. The root page (`/`,
 * the landing site's "Anmelden" target) used to call it directly inside its
 * render: every anonymous visit to `/?sign-in` threw mid-render and surfaced
 * the app-wide error boundary instead of WorkOS. The page now redirects here,
 * and this handler — a Route Handler, where cookie mutation is legal — issues
 * the authorization redirect with its PKCE cookie attached.
 *
 * Anonymous by design: like /api/auth/callback, it runs BEFORE a session
 * exists — creating one is its whole job — so no session-based posture can
 * apply. AuthKit's middlewareAuth lets it through via
 * proxy.ts unauthenticatedPaths.
 */
export const GET = tenantSlotRoute(async (): Promise<Response> => {
  const url = await getSignInUrl()
  return NextResponse.redirect(url)
})
