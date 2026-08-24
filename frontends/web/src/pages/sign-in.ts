import type { APIRoute } from 'astro'

/**
 * Sign-in hand-off to the app.
 *
 * The nav link points HERE (relative), not straight at the app: the target
 * host is deployment configuration and must be resolved at RUNTIME so one
 * image serves every stack. Prerendered HTML cannot do that - a host baked
 * into the static build is how the production landing page once sent visitors
 * to the dev app. The Deployment injects `PUBLIC_APP_URL`
 * (`https://app.<baseDomain>` via Pulumi); unset falls back to prod, matching
 * the fail-safe rule of `GRID_LANDING_URL` on the app side.
 *
 * The `?sign-in` marker is required. The app's root redirects logged-out
 * visitors back to this landing site, so linking at the bare APP_URL bounces
 * the visitor straight back here and sign-in is unreachable. The marker tells
 * the app the visit is deliberate, and it redirects to WorkOS instead.
 *
 * 302, not 301: the target comes from the environment, and a permanently
 * cached redirect would freeze whatever host answered first.
 */
export const prerender = false

export const GET: APIRoute = () => {
  const appUrl = (process.env.PUBLIC_APP_URL ?? 'https://app.piloti.at').replace(/\/+$/, '')
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${appUrl}/?sign-in`,
      // The redirect target is configuration, not content - no layer between
      // here and the browser may remember a previous answer.
      'Cache-Control': 'no-store',
    },
  })
}
