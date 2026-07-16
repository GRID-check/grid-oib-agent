/**
 * Deep Research API Route Proxy
 *
 * Proxies requests to the deep research async jobs API.
 * This avoids CORS issues by keeping browser requests on the same origin.
 *
 * Authentication handling:
 * - When REQUIRE_AUTH=true: Forwards idToken cookie to backend for backend authentication
 * - When REQUIRE_AUTH=false: Skips all auth info to ensure anonymous requests
 *
 * Session/bearer resolution (incl. the `?token=` fallback for EventSource
 * streams) is shared with the v1 proxy via `@/lib/proxy/proxy-request`.
 *
 * Handles:
 * - GET /api/jobs/async/agents - List available agents
 * - POST /api/jobs/async/submit - Submit a new job
 * - GET /api/jobs/async/job/{job_id} - Get job status
 * - GET /api/jobs/async/job/{job_id}/stream - SSE stream (primary use case)
 * - GET /api/jobs/async/job/{job_id}/stream/{last_event_id} - SSE reconnection
 * - POST /api/jobs/async/job/{job_id}/cancel - Cancel job
 * - DELETE /api/jobs/async/job/{job_id}/cancel - Cancel job
 * - GET /api/jobs/async/job/{job_id}/state - Get job artifacts
 * - GET /api/jobs/async/job/{job_id}/report - Get final report
 *
 * @see docs/api.md - Deep Research API section
 */

import { NextResponse } from 'next/server'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { isAuthzError } from '@/lib/auth-utils'
import { getActiveModelOverrides } from '@/lib/model-config/service'
import { encodeModelOverridesHeader } from '@/lib/model-config/header-encoding'
import {
  buildAuthHeaders,
  backendErrorEnvelope,
  noResponseBodyEnvelope,
  handleAuthzError,
  proxyErrorEnvelope,
  sseStreamResponse,
} from '@/lib/backend-proxy'
import { parseBodyContext, parseQueryContext } from '@/lib/proxy/collection-authz'
import { buildProxyUrl, resolveSessionAndBearer } from '@/lib/proxy/proxy-request'
import type { GridSession } from '@/lib/auth/types'

/**
 * Per-org runtime model overrides ({agentGroup: openrouterModelId}) for the
 * async-submit proxy — same header/encoding server.js forwards on the
 * WebSocket upgrade (x-grid-model-overrides, base64url JSON), decoded by the
 * backend (model_overrides.py). Without it, submit falls through to the
 * WS-only override path and jobs silently run on YAML-default models even
 * when the org has configured overrides.
 *
 * Best-effort: a lookup failure must not block job submission — the caller
 * proceeds without the header (backend defaults apply), matching the
 * fail-open contract of every other override consumer.
 */
async function resolveModelOverridesHeader(session: GridSession | null): Promise<string | undefined> {
  if (!session?.organizationId) return undefined
  try {
    const overrides = await getActiveModelOverrides(session.organizationId)
    return overrides ? encodeModelOverridesHeader(overrides) : undefined
  } catch (error) {
    console.warn('[Deep Research API] Failed to load model overrides:', error)
    return undefined
  }
}

const LOG_LABEL = 'Deep Research API'
const JOBS_BASE_PATH = '/v1/jobs/async'

/**
 * Handle GET requests (status, stream, state, report)
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const isStreamRequest = path.includes('stream')
    const { searchParams } = new URL(req.url)

    // SSE reconnection: the browser's EventSource automatically sends a
    // `Last-Event-ID` header when it reconnects after a dropped connection.
    // Map it onto the backend's /stream/{last_event_id} resume endpoint so
    // reconnects resume after the last delivered event instead of replaying
    // the whole job (duplicated steps/tool calls, double-counted tokens).
    // Backend event ids are integers — anything else is ignored so a bogus
    // header can never break the stream.
    const lastEventId = req.headers.get('Last-Event-ID')?.trim()
    const upstreamPath =
      isStreamRequest &&
      path[path.length - 1] === 'stream' &&
      lastEventId &&
      /^\d+$/.test(lastEventId)
        ? [...path, lastEventId]
        : path
    const backendUrl = buildProxyUrl(JOBS_BASE_PATH, upstreamPath)

    console.log('[Deep Research API] GET:', backendUrl, isStreamRequest ? '(SSE)' : '')

    const { session, authHeader } = await resolveSessionAndBearer(req, path, LOG_LABEL)
    const authHeaders = buildAuthHeaders(authHeader)
    console.log('[Deep Research API] WorkOS access token present:', !!authHeaders.Authorization)

    const { headerValue } = await buildCollectionScopeFromRequest(session, parseQueryContext(searchParams))

    // The token query param is consumed for auth and forwarded via headers.
    const upstreamUrl = buildProxyUrl(JOBS_BASE_PATH, upstreamPath, searchParams, ['token'])

    // Forward the request to the backend
    const response = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        ...authHeaders,
        Accept: isStreamRequest ? 'text/event-stream' : 'application/json',
        'X-Grid-Collection-Scope': headerValue,
      },
      ...(isStreamRequest ? { signal: req.signal } : {}),
    })

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Deep Research API] Backend error:', response.status, errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    // For SSE streams, pass through the response body
    if (isStreamRequest) {
      if (!response.body) {
        return noResponseBodyEnvelope('Backend returned no SSE stream body')
      }

      // Stream the SSE response back to the client
      return sseStreamResponse(response.body, {
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      })
    }

    // For regular JSON responses
    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    console.error('[Deep Research API] GET error:', error)

    return proxyErrorEnvelope(error)
  }
}

/**
 * Handle POST requests (submit, cancel)
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const backendUrl = buildProxyUrl(JOBS_BASE_PATH, path)

    console.log('[Deep Research API] POST:', backendUrl)

    // Get the request body (may be empty for cancel)
    let parsedBody: Record<string, unknown> | undefined
    let body: string | undefined
    try {
      parsedBody = await req.json()
      body = JSON.stringify(parsedBody)
    } catch {
      // No body or invalid JSON - that's okay for cancel
      parsedBody = undefined
      body = undefined
    }

    const { session, authHeader } = await resolveSessionAndBearer(req, path, LOG_LABEL)
    const authHeaders = buildAuthHeaders(authHeader)
    console.log('[Deep Research API] POST WorkOS access token present:', !!authHeaders.Authorization)

    // Deep research is flag-gated (expensive workflow). Only the submit
    // entry point is gated — cancel/stream on running jobs stay available.
    // Anonymous mode (REQUIRE_AUTH=false) has no session to evaluate.
    if (path[0] === 'submit' && session) {
      const gated = requireFeature(session, FEATURE_FLAGS.deepResearch)
      if (gated) return gated
    }

    const { headerValue } = await buildCollectionScopeFromRequest(session, parseBodyContext(parsedBody))
    const modelOverridesHeader = await resolveModelOverridesHeader(session)

    // Forward the request to the backend
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        'X-Grid-Collection-Scope': headerValue,
        ...(modelOverridesHeader ? { 'X-Grid-Model-Overrides': modelOverridesHeader } : {}),
      },
      ...(body ? { body } : {}),
    })

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Deep Research API] Backend error:', response.status, errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    // Return JSON response
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    console.error('[Deep Research API] POST error:', error)

    return proxyErrorEnvelope(error)
  }
}

/**
 * Handle DELETE requests (cancel)
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const backendUrl = buildProxyUrl(JOBS_BASE_PATH, path)
    const { searchParams } = new URL(req.url)

    console.log('[Deep Research API] DELETE:', backendUrl)

    const { session, authHeader } = await resolveSessionAndBearer(req, path, LOG_LABEL)
    const authHeaders = buildAuthHeaders(authHeader)
    console.log('[Deep Research API] DELETE WorkOS access token present:', !!authHeaders.Authorization)

    const { headerValue } = await buildCollectionScopeFromRequest(session, parseQueryContext(searchParams))

    const upstreamUrl = buildProxyUrl(JOBS_BASE_PATH, path, searchParams, ['token'])

    const response = await fetch(upstreamUrl, {
      method: 'DELETE',
      headers: {
        ...authHeaders,
        Accept: 'application/json',
        'X-Grid-Collection-Scope': headerValue,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Deep Research API] DELETE Backend error:', response.status, errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    const data = await response.json().catch(() => ({}))
    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    console.error('[Deep Research API] DELETE error:', error)

    return proxyErrorEnvelope(error)
  }
}
