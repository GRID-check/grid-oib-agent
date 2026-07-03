// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate API Route
 *
 * Proxies generate stream requests to the backend server.
 * This avoids CORS issues by keeping browser requests on the same origin.
 *
 * Authentication handling:
 * - When REQUIRE_AUTH=true: Forwards idToken cookie to backend for backend authentication
 * - When REQUIRE_AUTH=false: Skips all auth info to ensure anonymous requests
 *
 * The /generate/stream endpoint returns:
 * - status messages (thinking, searching, planning, writing, complete, error)
 * - intermediate messages (thinking content for Details Panel)
 * - prompt messages (agent prompts requiring user response)
 * - report messages (final report for Details Panel)
 */

import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import type { GridSession } from '@/lib/auth/types'
import { isAuthzError } from '@/lib/auth-utils'
import {
  isAuthRequired,
  getBackendUrl,
  resolveBearerAuthHeader,
  buildAuthHeaders,
  backendErrorEnvelope,
  noResponseBodyEnvelope,
  handleAuthzError,
  proxyErrorEnvelope,
  sseStreamResponse,
} from '@/lib/backend-proxy'

export async function POST(req: Request): Promise<Response> {
  try {
    // Get the request body
    const body = await req.json()

    // Skip auth when REQUIRE_AUTH=false - don't forward any auth info to backend
    const authRequired = isAuthRequired()

    let session: GridSession | null = null
    let authHeader: string | null = null
    if (authRequired) {
      session = await requireAuthorizedSession()
      authHeader = resolveBearerAuthHeader(req, session)
    }

    const conversationId = body.conversationId || body.session_id
    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      projectId: body.projectId,
      conversationId,
    })

    // Build the backend URL for /generate/stream
    const backendUrl = `${getBackendUrl()}/generate/stream`

    console.log('[Generate API] Proxying request to:', backendUrl)
    console.log('[Generate API] Auth required:', authRequired)
    console.log('[Generate API] WorkOS access token present:', !!authHeader)

    // Forward the request to the backend
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(authHeader),
        'X-Grid-Collection-Scope': headerValue,
      },
      body: JSON.stringify(body),
    })

    console.log('[Generate API] Backend response status:', response.status)

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Generate API] Backend error:', errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    // Check if we have a response body
    if (!response.body) {
      return noResponseBodyEnvelope()
    }

    // Stream the response back to the client
    // We pass through the SSE stream unchanged
    return sseStreamResponse(response.body)
  } catch (error) {
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    console.error('[Generate API] Proxy error:', error)

    return proxyErrorEnvelope(error)
  }
}
