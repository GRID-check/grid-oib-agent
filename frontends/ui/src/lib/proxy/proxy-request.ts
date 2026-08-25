/**
 * Shared request plumbing for the backend proxy routes
 * (`/api/v1/[...path]`, `/api/jobs/async/[...path]`).
 *
 * Complements `@/lib/backend-proxy` (error envelopes, base URL, session
 * resolution) with the pieces those routes previously duplicated: building
 * the upstream URL from a catch-all path, and resolving the session + bearer
 * header including the `?token=` fallback used by EventSource streams.
 */

import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import type { GridSession } from '@/lib/auth/types'
import { getBackendUrl, isAuthRequired } from '@/lib/backend-proxy'

/**
 * Build the upstream backend URL for a catch-all proxy path.
 *
 * @param basePath backend path prefix (e.g. `/v1`, `/v1/jobs/async`).
 * @param path     the catch-all segments from the route params.
 * @param searchParams query params to forward (omit to forward none).
 * @param omitParams   param names consumed by the proxy (e.g. `token`) that
 *                     must never reach the backend URL.
 */
export function buildProxyUrl(
  basePath: string,
  path: string[],
  searchParams?: URLSearchParams,
  omitParams: string[] = []
): string {
  const url = new URL(`${getBackendUrl()}${basePath}/${path.join('/')}`)
  searchParams?.forEach((value, key) => {
    if (!omitParams.includes(key)) {
      url.searchParams.set(key, value)
    }
  })
  return url.toString()
}

/**
 * Resolve the current Grid session and the Authorization header to forward.
 * Returns a null session and no header when REQUIRE_AUTH=false (anonymous
 * mode must not leak auth info).
 *
 * Bearer precedence: incoming `Authorization` header, then the `?token=`
 * query fallback (stream paths only — EventSource cannot set headers), then
 * the session's WorkOS access token.
 *
 * The query token is consumed here and forwarded only via headers, never as
 * part of an upstream URL, and it is never logged (`label` is only used for
 * the diagnostic warning below).
 */
export async function resolveSessionAndBearer(
  req: Request,
  pathSegments: string[],
  label: string
): Promise<{ session: GridSession | null; authHeader: string | null }> {
  if (!isAuthRequired()) {
    return { session: null, authHeader: null }
  }

  const session = await requireAuthorizedSession()

  // Only allow query token for stream paths (EventSource can't set headers).
  // Note: tokens in URLs may appear in server access logs. This is a
  // server-side route handler — the token is extracted here and forwarded
  // only via headers, never passed on as a URL to the backend.
  const allowQueryToken = pathSegments.includes('stream')
  const rawQueryToken = new URL(req.url).searchParams.get('token')?.trim()
  const queryToken = allowQueryToken && rawQueryToken ? rawQueryToken : undefined

  const headerToken =
    req.headers.get('Authorization') || (queryToken ? `Bearer ${queryToken}` : null)
  const authHeader = headerToken || (session.accessToken ? `Bearer ${session.accessToken}` : null)

  if (queryToken && !authHeader) {
    console.warn(
      `[${label}] SSE stream using ?token= query fallback (WorkOS session cookie missing)`
    )
  }

  return { session, authHeader }
}
