// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import type { GridSession } from '@/lib/auth/types'
import { isAuthzError } from '@/lib/auth-utils'
import {
  isAuthRequired,
  getBackendUrl,
  buildAuthHeaders,
  backendErrorEnvelope,
  noResponseBodyEnvelope,
  handleAuthzError,
  proxyErrorEnvelope,
  sseStreamResponse,
} from '@/lib/backend-proxy'

/**
 * Build the backend URL for deep research API
 */
const buildBackendUrl = (path: string[]): string => {
  const backendBase = getBackendUrl()
  const pathString = path.join('/')
  return `${backendBase}/v1/jobs/async/${pathString}`
}

/**
 * Resolve the current Grid session and auth header.
 * Returns null session and no header when REQUIRE_AUTH=false.
 */
async function resolveSessionAndAuth(
  req: Request,
  pathSegments: string[]
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

  const headerToken = req.headers.get('Authorization') || (queryToken ? `Bearer ${queryToken}` : null)
  const authHeader = headerToken || (session.accessToken ? `Bearer ${session.accessToken}` : null)

  if (queryToken && !authHeader) {
    console.warn('[Deep Research API] SSE stream using ?token= query fallback (WorkOS session cookie missing)')
  }

  return { session, authHeader }
}

function buildUpstreamUrl(backendUrl: string, searchParams: URLSearchParams): URL {
  const upstreamUrl = new URL(backendUrl)
  searchParams.forEach((value, key) => {
    // The token query param is consumed for auth and forwarded via headers.
    if (key !== 'token') {
      upstreamUrl.searchParams.set(key, value)
    }
  })
  return upstreamUrl
}

/**
 * Handle GET requests (status, stream, state, report)
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const backendUrl = buildBackendUrl(path)
    const isStreamRequest = path.includes('stream')
    const { searchParams } = new URL(req.url)

    console.log('[Deep Research API] GET:', backendUrl, isStreamRequest ? '(SSE)' : '')

    const { session, authHeader } = await resolveSessionAndAuth(req, path)
    const authHeaders = buildAuthHeaders(authHeader)
    console.log('[Deep Research API] WorkOS access token present:', !!authHeaders.Authorization)

    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      projectId: searchParams.get('projectId') || undefined,
      conversationId: searchParams.get('conversationId') || undefined,
    })

    const upstreamUrl = buildUpstreamUrl(backendUrl, searchParams)

    // Forward the request to the backend
    const response = await fetch(upstreamUrl.toString(), {
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
    const backendUrl = buildBackendUrl(path)

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

    const { session, authHeader } = await resolveSessionAndAuth(req, path)
    const authHeaders = buildAuthHeaders(authHeader)
    console.log('[Deep Research API] POST WorkOS access token present:', !!authHeaders.Authorization)

    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      projectId: typeof parsedBody?.projectId === 'string' ? parsedBody.projectId : undefined,
      conversationId:
        typeof parsedBody?.conversationId === 'string'
          ? parsedBody.conversationId
          : typeof parsedBody?.session_id === 'string'
            ? parsedBody.session_id
            : undefined,
    })

    // Forward the request to the backend
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        'X-Grid-Collection-Scope': headerValue,
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
    const backendUrl = buildBackendUrl(path)
    const { searchParams } = new URL(req.url)

    console.log('[Deep Research API] DELETE:', backendUrl)

    const { session, authHeader } = await resolveSessionAndAuth(req, path)
    const authHeaders = buildAuthHeaders(authHeader)
    console.log('[Deep Research API] DELETE WorkOS access token present:', !!authHeaders.Authorization)

    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      projectId: searchParams.get('projectId') || undefined,
      conversationId: searchParams.get('conversationId') || undefined,
    })

    const upstreamUrl = buildUpstreamUrl(backendUrl, searchParams)

    const response = await fetch(upstreamUrl.toString(), {
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
