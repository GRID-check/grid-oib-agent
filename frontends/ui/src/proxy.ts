/**
 * Next.js Proxy for WorkOS AuthKit v4 Session Management
 *
 * Uses authkitProxy from @workos-inc/authkit-nextjs to:
 * - Decrypt and refresh the encrypted WorkOS session cookie
 * - Attach the encrypted session to downstream requests via the internal
 *   x-workos-session header
 * - Enforce authentication on protected routes when REQUIRE_AUTH=true
 *
 * The Python backend receives the raw WorkOS access token from the v1 API
 * route proxy, which reads the session with withAuth() and forwards it as
 * Authorization: Bearer <access_token>.
 */

import { authkitMiddleware } from '@workos-inc/authkit-nextjs'
import type { NextFetchEvent, NextRequest } from 'next/server'

const isAuthRequired = (): boolean => {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

const middleware = authkitMiddleware({
  debug: process.env.NODE_ENV === 'development',
  middlewareAuth: {
    enabled: isAuthRequired(),
    unauthenticatedPaths: [
      // Public marketing landing. AuthKit compiles these paths with
      // path-to-regexp (anchored), so '/' matches only the root.
      '/',
      // Liveness probe — must return 200 even when auth is required, so the
      // container / Coolify / Traefik health check never redirects to login.
      '/api/healthz',
      '/api/auth/callback',
      '/api/auth/websocket-scope',
      '/auth/error',
      // Internal service-to-service endpoints (e.g. the backend agent's
      // `remember` tool). These carry no WorkOS session cookie; each route
      // enforces its own shared-token auth (X-Grid-Internal-Token). Without
      // this entry AuthKit 303-redirects the POST to WorkOS sign-in.
      '/api/internal/(.*)',
      // Signed document images. `_next/image` is excluded from the matcher
      // below, but the optimizer does not fetch the underlying route over the
      // network — it re-enters the router server handler in-process, so
      // middleware DOES run on it, with a mocked request that carries no
      // cookies. Without this entry AuthKit 303-redirects our own optimizer to
      // WorkOS sign-in and every document image breaks. The route is not
      // unguarded: it verifies the HMAC signature on the URL itself
      // (`@/lib/images/signed-image-url`), which is the same shape of argument
      // as the internal endpoints above.
      '/api/documents/(.*)/image',
    ],
  },
})

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  return middleware(request, event)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     *
     * API auth routes are allow-listed via middlewareAuth.unauthenticatedPaths
     * so AuthKit can complete the OAuth callback without a session.
     *
     * `api/healthz` is excluded from the matcher entirely: the liveness probe
     * must answer 200 purely on "is the Node server up", independent of AuthKit
     * (which otherwise throws on every request when WORKOS_REDIRECT_URI is
     * unset/misconfigured — turning a config gap into a container that never
     * goes healthy).
     */
    '/((?!_next/static|_next/image|favicon.ico|public|api/healthz).*)',
  ],
}
