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
 * - Attaches X-Grid-Collection-Scope to every upstream request. Its payload is
 *   `base64url(JSON.stringify([{collection, shelf?}, ...]))` — each collection
 *   states its shelf (`archiv | project | session | base`) explicitly, so no
 *   consumer re-derives it from a name prefix (ADR-0047). The value is built
 *   whole by `buildCollectionScopeFromRequest`, which is where the shelves are
 *   known; this route only forwards it.
 * - Forwards only the requests a product client makes
 *   (`@/lib/proxy/v1-allowlist`); everything else is a 404.
 * - Validates collection_name for collection-scoped routes (e.g. uploads)
 *   via `@/lib/proxy/collection-authz`, per method.
 *
 * This route stays a transport pass-through (see the BFF architecture doc):
 * no repository/service layer, but authz and scope resolution go through the
 * shared guards.
 */

import { NextResponse } from 'next/server'
import { tenantSlotRoute } from '@/lib/db/tenant-context'
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
import { isForwardableV1Request } from '@/lib/proxy/v1-allowlist'
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
 * Forward only what a product client asks for (`@/lib/proxy/v1-allowlist`).
 *
 * The proxy forwards to `BACKEND_URL` (the `aiq-api` service) over the internal network, so the
 * backend's `AuthMiddleware` classifies these requests as *internal* and skips
 * its `EXTERNAL_ALLOWED_PATHS` filter. A denylist of the two control-plane
 * prefixes (`admin`, `maintenance`) was therefore the only thing between a
 * browser cookie and the agent service's whole surface, NAT's agent-turn
 * endpoints (`/v1/chat/completions`, `/v1/workflow`) included — which ran
 * outside the signed context envelope, so with no organization, budget or
 * source policy. An allowlist closes those and whatever is mounted next.
 * Rejected before any upstream fetch, with the same 404 for every shape.
 */
const rejectUnlistedPath = (method: string, path: string[]): NextResponse | null => {
  if (isForwardableV1Request(method, path)) return null
  return errorEnvelope(404, 'NOT_FOUND', 'Not found')
}

export const GET = tenantSlotRoute(async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const blocked = rejectUnlistedPath(req.method, path)
    if (blocked) {
      return blocked
    }
    const { searchParams } = new URL(req.url)
    const session = await resolveOptionalSession()
    const context = parseQueryContext(searchParams)

    const validationError = await validateCollectionName(path, session, context, {
      method: req.method,
    })
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
})

export const POST = tenantSlotRoute(async function POST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const blocked = rejectUnlistedPath(req.method, path)
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

    const validationError = await validateCollectionName(path, session, context, {
      method: req.method,
    })
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
})

export const DELETE = tenantSlotRoute(async function DELETE(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const blocked = rejectUnlistedPath(req.method, path)
    if (blocked) {
      return blocked
    }
    const { searchParams } = new URL(req.url)
    const session = await resolveOptionalSession()
    const context = parseQueryContext(searchParams)

    const validationError = await validateCollectionName(path, session, context, {
      method: req.method,
    })
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
})
