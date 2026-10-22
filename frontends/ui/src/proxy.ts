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
import { isAuthRequired } from '@/lib/auth/auth-required'

const middleware = authkitMiddleware({
  debug: process.env.NODE_ENV === 'development',
  middlewareAuth: {
    enabled: isAuthRequired(),
    unauthenticatedPaths: [
      // Root redirect page (sends logged-out visitors to the public landing
      // site via GRID_LANDING_URL). AuthKit compiles these paths with
      // path-to-regexp (anchored), so '/' matches only the root.
      '/',
      // Liveness probe — must return 200 even when auth is required, so the
      // container / Coolify / Traefik health check never redirects to login.
      '/api/healthz',
      '/api/auth/callback',
      // Sign-in entry point behind /?sign-in (the landing site's "Anmelden"
      // target). Like the callback it runs BEFORE a session exists — it mints
      // the AuthKit authorization redirect and its PKCE cookie. Without this
      // entry middlewareAuth would intercept it and 303 to WorkOS itself,
      // bypassing the handler.
      '/api/auth/signin',
      '/api/auth/websocket-scope',
      '/auth/error',
      // Internal service-to-service endpoints (e.g. the backend agent's
      // `remember` tool). These carry no WorkOS session cookie; each route
      // enforces its own shared-token auth (X-Grid-Internal-Token). Without
      // this entry AuthKit 303-redirects the POST to WorkOS sign-in.
      '/api/internal/(.*)',
      // The agent door (ADR-0122): the MCP endpoint and the OAuth discovery
      // documents an MCP client fetches before it has any credential. Clients
      // carry no AuthKit cookie; `/api/mcp` authenticates itself, a WorkOS
      // bearer token for an external agent or the signed request-context
      // envelope for Piloti, and the `.well-known` documents are public by
      // specification (RFC 9728).
      '/api/mcp',
      // The A2A door (ADR-0124): authenticates itself with the same bearer
      // token as `/api/mcp`; the agent card is under `.well-known`.
      '/api/a2a',
      // The platform door (ADR-0126): the operator console's MCP server.
      // Authenticates itself with a bearer token for its own audience, issued
      // in the GRID Platform organization; every operation's route still
      // checks its `platform:*` permission.
      '/api/platform/mcp',
      // PostHog Support's poke that a feedback ticket has a new message
      // (ADR-0118, second amendment). PostHog carries no session; the route
      // reads nothing from the body but a ticket id and reads the thread back
      // from PostHog with the server's key, so a forged poke can only make it
      // re-read a real ticket. Rate limited in the route.
      '/api/webhooks/posthog-support',
      '/.well-known/(.*)',
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
     * - favicon.ico, icon.svg, apple-icon.png, manifest.webmanifest, robots.txt, sw.js
     *   and icons/ (app/ file conventions and public/icons). Each file name is
     *   escaped and anchored (`sw\.js$`): unanchored, `sw.js` also let
     *   `/sw.jsx`, `/swxjs` and `/sw.js/anything` past the session. `sw.js` is the
     *   notification worker: a browser re-fetches it with or without a session,
     *   and an AuthKit redirect to WorkOS would read as a failed update: a signed-out
     *   browser, a crawler or the sign-in page's own tab must get them rather
     *   than a redirect to WorkOS
     * - art/ (public/art, the riso prints): the not-found page shows one, and
     *   a signed-out visitor sees that page too
     * - public folder
     * - ingest/ (the first-party PostHog relay, `app/ingest/[...path]/route.ts`):
     *   the SDK posts from signed-out pages and mid-expiry, where an AuthKit
     *   redirect to WorkOS would answer a beacon with a login page, and the
     *   proxy would buffer megabyte-sized replay bodies against
     *   `proxyClientMaxBodySize`. The route is `publicApiRoute` and forwards no
     *   cookie or credential.
     * - api/internal/signed/ (the RFC 9421 signed internal routes,
     *   `internalApiRoute` with `auth.signature`): a caller outside the cluster
     *   pushes a raw body there, and a proxied body is buffered and, above
     *   `proxyClientMaxBodySize`, handed to the route cut short without an
     *   error. Skipping the proxy hands the route the unbuffered stream, which
     *   `lib/api/bounded-body.ts` holds to the signed length and digest. The
     *   routes authenticate themselves before reading a byte and carry no
     *   session, so AuthKit has nothing to do there. Only this sub-path: the
     *   token-guarded `/api/internal/*` routes stay on the matcher.
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
    '/((?!_next/static|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|manifest\\.webmanifest$|robots\\.txt$|sw\\.js$|icons/|art/|public|api/healthz|ingest/|api/internal/signed/).*)',
  ],
}
