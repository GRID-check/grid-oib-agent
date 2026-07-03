// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Chat API Route
 *
 * Proxies chat completion requests to the backend server.
 * This avoids CORS issues by keeping browser requests on the same origin.
 *
 * Authentication handling:
 * - When REQUIRE_AUTH=true: Forwards idToken cookie to backend for backend authentication
 * - When REQUIRE_AUTH=false: Skips all auth info to ensure anonymous requests
 */

import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
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

    const { headerValue, projectId } = await buildCollectionScopeFromRequest(session, {
      projectId: body.projectId,
      conversationId: body.conversationId,
    })

    let projectContext = null
    if (body.projectId && projectId) {
      if (authRequired && session) {
        await requireProjectAccess(session as AuthorizedSession, projectId, 'project:view')
      }
      projectContext = await loadProjectPromptView(projectId)
    }

    // Build the backend URL
    const backendUrl = `${getBackendUrl()}/chat/stream`

    console.log('[Chat API] Proxying request to:', backendUrl)
    console.log('[Chat API] Auth required:', authRequired)
    console.log('[Chat API] WorkOS access token present:', !!authHeader)

    // Forward the request to the backend
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(authHeader),
        'X-Grid-Collection-Scope': headerValue,
        ...(projectContext ? { 'X-Grid-Project-Context': projectContext } : {}),
      },
      body: JSON.stringify(body),
    })

    console.log('[Chat API] Backend response status:', response.status)

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Chat API] Backend error:', errorText)

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

    console.error('[Chat API] Proxy error:', error)

    return proxyErrorEnvelope(error)
  }
}


