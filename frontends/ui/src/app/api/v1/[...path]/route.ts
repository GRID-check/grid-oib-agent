/**
 * V1 API Proxy Route
 *
 * Proxies requests to the backend /v1/* endpoints.
 * Handles collections, documents, data_sources, and other v1 APIs.
 *
 * This allows the frontend to make requests to the same origin,
 * with the backend URL configured at runtime via BACKEND_URL env var.
 *
 * Authentication handling:
 * - In auth-required mode, resolves an authorized Grid session and forwards
 *   the WorkOS access token as Authorization: Bearer <token>.
 * - In anonymous mode, no Authorization header is sent.
 *
 * Collection scoping:
 * - Attaches X-Grid-Collection-Scope to every upstream request.
 * - Validates collection_name for collection-scoped routes (e.g. uploads)
 *   via `@/lib/proxy/collection-authz`.
 *
 * This route stays a transport pass-through (see the BFF architecture doc):
 * no repository/service layer, but authz and scope resolution go through the
 * shared guards.
 */

import { NextResponse } from 'next/server'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { isAuthzError } from '@/lib/auth-utils'
import {
  resolveOptionalSession,
  backendErrorEnvelope,
  handleAuthzError,
  proxyErrorEnvelope,
  errorEnvelope,
} from '@/lib/backend-proxy'
import {
  parseQueryContext,
  resolveRequestContext,
  validateCollectionName,
} from '@/lib/proxy/collection-authz'
import { buildProxyUrl } from '@/lib/proxy/proxy-request'
import { isWebSearchEnabledForOrg } from '@/lib/organizations/service'

/**
 * Sources hidden from the org (ADR-0022). Applied to the `/v1/data_sources`
 * listing so a disabled tool disappears from the picker; the hard gate is
 * the `x-grid-disabled-sources` WS header + submit-time subtraction, so this
 * filter is UX, not the security boundary. Fail-open: a settings lookup
 * error must not break the listing.
 */
async function filterDataSourcesResponse(
  path: string[],
  organizationId: string | null | undefined,
  data: unknown
): Promise<unknown> {
  if (path.length !== 1 || path[0] !== 'data_sources' || !organizationId) return data
  try {
    if (await isWebSearchEnabledForOrg(organizationId)) return data
  } catch {
    return data
  }
  const dropWebSearch = (sources: unknown[]): unknown[] =>
    sources.filter(
      (source) =>
        !(source && typeof source === 'object' && (source as { id?: unknown }).id === 'web_search')
    )
  // The backend returns `{ data_sources, vlm_available }`; older/other shapes
  // may return a bare array. Filter web_search in either while preserving the
  // capability fields (e.g. vlm_available) untouched.
  if (Array.isArray(data)) return dropWebSearch(data)
  if (
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { data_sources?: unknown }).data_sources)
  ) {
    return {
      ...data,
      data_sources: dropWebSearch((data as { data_sources: unknown[] }).data_sources),
    }
  }
  return data
}

const isRedirectError = (error: unknown): boolean => {
  return error instanceof Error && error.message === 'NEXT_REDIRECT'
}

/**
 * Backend control-plane path prefixes that must NEVER be reachable through the
 * public BFF proxy.
 *
 * The proxy forwards to `aiq-agent:8000` over the internal network, so the
 * backend's `AuthMiddleware` classifies these requests as *internal* and skips
 * its `EXTERNAL_ALLOWED_PATHS` filter. Without this guard an anonymous visitor
 * on the public frontend could reach:
 *   - `/v1/admin/*`       — GRID_ADMIN_TOKEN-gated OIB re-ingestion (fail-OPEN
 *                           when the token is unset), and
 *   - `/v1/maintenance/*` — internal-token-gated project purge.
 * Neither prefix appears in the backend's `EXTERNAL_ALLOWED_PATHS`, so the
 * proxy's forwardable set is kept no wider than what an external caller may
 * reach. Legitimate v1 paths (collections, documents, data_sources, jobs,
 * config) are unaffected. Rejected before any upstream fetch.
 */
const BLOCKED_PROXY_PREFIXES = new Set(['admin', 'maintenance'])

const rejectBlockedPath = (path: string[]): NextResponse | null => {
  if (path.length > 0 && BLOCKED_PROXY_PREFIXES.has(path[0])) {
    return errorEnvelope(404, 'NOT_FOUND', 'Not found')
  }
  return null
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const blocked = rejectBlockedPath(path)
    if (blocked) {
      return blocked
    }
    const { searchParams } = new URL(req.url)
    const session = await resolveOptionalSession()
    const context = parseQueryContext(searchParams)

    const validationError = await validateCollectionName(path, session, context)
    if (validationError) {
      return validationError
    }

    const { headerValue } = await buildCollectionScopeFromRequest(session, context)
    const authHeaders: Record<string, string> = session
      ? { Authorization: `Bearer ${session.accessToken}` }
      : {}

    const response = await fetch(buildProxyUrl('/v1', path, searchParams), {
      method: 'GET',
      headers: {
        ...authHeaders,
        Accept: 'application/json',
        'X-Grid-Collection-Scope': headerValue,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      return backendErrorEnvelope(response.status, errorText)
    }

    const data = await response.json()
    return NextResponse.json(await filterDataSourcesResponse(path, session?.organizationId, data))
  } catch (error) {
    if (isRedirectError(error)) {
      throw error
    }
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    return proxyErrorEnvelope(error)
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const blocked = rejectBlockedPath(path)
    if (blocked) {
      return blocked
    }
    const { searchParams } = new URL(req.url)
    const session = await resolveOptionalSession()
    const contentType = req.headers.get('Content-Type') || 'application/json'

    let parsedBody: Record<string, unknown> | undefined
    let body: BodyInit | undefined
    const requestHeaders: Record<string, string> = {}

    if (contentType.includes('multipart/form-data')) {
      // Stream the raw body to avoid buffering large uploads in memory
      body = req.body as ReadableStream<Uint8Array>
      requestHeaders['Content-Type'] = contentType
    } else {
      requestHeaders['Content-Type'] = 'application/json'
      try {
        parsedBody = await req.json()
        body = JSON.stringify(parsedBody)
      } catch {
        parsedBody = undefined
        body = undefined
      }
    }

    const context = resolveRequestContext(searchParams, parsedBody)

    const validationError = await validateCollectionName(path, session, context)
    if (validationError) {
      return validationError
    }

    const { headerValue } = await buildCollectionScopeFromRequest(session, context)
    const authHeaders: Record<string, string> = session
      ? { Authorization: `Bearer ${session.accessToken}` }
      : {}

    const response = await fetch(buildProxyUrl('/v1', path, searchParams), {
      method: 'POST',
      headers: {
        ...authHeaders,
        ...requestHeaders,
        'X-Grid-Collection-Scope': headerValue,
      },
      ...(body ? { body, duplex: 'half' } : {}),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return backendErrorEnvelope(response.status, errorText)
    }

    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    if (isRedirectError(error)) {
      throw error
    }
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    return proxyErrorEnvelope(error)
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const blocked = rejectBlockedPath(path)
    if (blocked) {
      return blocked
    }
    const { searchParams } = new URL(req.url)
    const session = await resolveOptionalSession()
    const context = parseQueryContext(searchParams)

    const validationError = await validateCollectionName(path, session, context)
    if (validationError) {
      return validationError
    }

    const { headerValue } = await buildCollectionScopeFromRequest(session, context)
    const authHeaders: Record<string, string> = session
      ? { Authorization: `Bearer ${session.accessToken}` }
      : {}

    let body: string | undefined
    try {
      const json = await req.json()
      body = JSON.stringify(json)
    } catch {
      body = undefined
    }

    const response = await fetch(buildProxyUrl('/v1', path, searchParams), {
      method: 'DELETE',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        'X-Grid-Collection-Scope': headerValue,
      },
      ...(body ? { body } : {}),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return backendErrorEnvelope(response.status, errorText)
    }

    if (response.status === 204) {
      return new NextResponse(null, { status: 204 })
    }

    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    if (isRedirectError(error)) {
      throw error
    }
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    return proxyErrorEnvelope(error)
  }
}
