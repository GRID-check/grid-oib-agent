/**
 * Shared BFF proxy helpers.
 *
 * Consolidates the boilerplate duplicated across the backend proxy routes
 * (chat, generate, generate/respond, jobs/async, v1): resolving whether
 * auth is required, computing the backend base URL, building the
 * WorkOS Authorization header, and shaping the `{ error: { code, message } }`
 * envelope returned to the browser.
 */

import { NextResponse } from 'next/server'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { isAuthRequired } from '@/lib/auth/auth-required'
import type { GridSession } from '@/lib/auth/types'

/**
 * Whether the backend requires WorkOS-authenticated requests.
 * When false, routes must skip all auth info to keep requests anonymous.
 *
 * Re-exported, not re-implemented: `@/lib/auth/auth-required` owns the rule for
 * pages, the AuthKit proxy and routes alike. The re-export keeps this module's
 * existing consumers importing from where they already do.
 */
export { isAuthRequired }

/**
 * Resolve the backend base URL, stripping any trailing slash.
 */
export const getBackendUrl = (): string => {
  const url = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}

/**
 * Resolve the current Grid session, or null when REQUIRE_AUTH=false.
 */
export async function resolveOptionalSession(): Promise<GridSession | null> {
  if (!isAuthRequired()) {
    return null
  }
  return requireAuthorizedSession()
}

/**
 * Resolve the Authorization header to forward to the backend: prefer an
 * incoming Authorization header on the request, otherwise fall back to the
 * session's WorkOS access token.
 */
export function resolveBearerAuthHeader(req: Request, session: GridSession | null): string | null {
  const headerToken = req.headers.get('Authorization')
  return headerToken || (session?.accessToken ? `Bearer ${session.accessToken}` : null)
}

/**
 * Build a headers record carrying the Authorization header, or an empty
 * record when there is no auth header to forward.
 */
export function buildAuthHeaders(authHeader: string | null): Record<string, string> {
  return authHeader ? { Authorization: authHeader } : {}
}

/**
 * Build the `{ error: { code, message } }` JSON envelope used by every BFF
 * proxy route.
 */
export function errorEnvelope(status: number, code: string, message: string): NextResponse {
  return new NextResponse(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Envelope for a non-OK response from the backend.
 */
export function backendErrorEnvelope(status: number, errorText: string): NextResponse {
  return errorEnvelope(status, 'BACKEND_ERROR', `Backend returned ${status}: ${errorText}`)
}

/**
 * Envelope for a caught authorization error (missing/forbidden/not found).
 * Mirrors the `isAuthzError` classification in `@/lib/auth-utils`.
 */
export function handleAuthzError(error: unknown): NextResponse {
  const status = error instanceof Error && error.message.toLowerCase() === 'not found' ? 404 : 403
  const code = status === 404 ? 'NOT_FOUND' : 'FORBIDDEN'

  return errorEnvelope(status, code, error instanceof Error ? error.message : 'Access denied')
}

/**
 * Envelope for an unexpected proxy-side error.
 */
export function proxyErrorEnvelope(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : 'Unknown error'
  return errorEnvelope(500, 'PROXY_ERROR', message)
}

/**
 * Envelope for a successful backend response missing a body when one was
 * expected (e.g. an SSE stream).
 */
export function noResponseBodyEnvelope(message = 'Backend returned no response body'): NextResponse {
  return errorEnvelope(500, 'NO_RESPONSE_BODY', message)
}

/**
 * Pass an SSE response body straight through to the client unchanged.
 */
export function sseStreamResponse(
  body: ReadableStream<Uint8Array>,
  extraHeaders?: Record<string, string>
): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...extraHeaders,
    },
  })
}
