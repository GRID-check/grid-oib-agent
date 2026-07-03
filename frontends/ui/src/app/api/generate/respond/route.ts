// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate Respond API Route
 *
 * Proxies HITL (human-in-the-loop) prompt responses to the backend.
 * Called by sendPromptResponse() in chat-client.ts when a user
 * approves/rejects an agent prompt.
 *
 * Authentication handling mirrors the parent /api/generate route:
 * - When REQUIRE_AUTH=true: Forwards idToken cookie to backend
 * - When REQUIRE_AUTH=false: Skips all auth info
 */

import { NextResponse } from 'next/server'
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
  handleAuthzError,
  proxyErrorEnvelope,
} from '@/lib/backend-proxy'

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json()

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

    const backendUrl = `${getBackendUrl()}/generate/respond`

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(authHeader),
        'X-Grid-Collection-Scope': headerValue,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Generate Respond API] Backend error:', errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    const data = await response.json().catch(() => ({}))
    return NextResponse.json(data)
  } catch (error) {
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    console.error('[Generate Respond API] Proxy error:', error)

    return proxyErrorEnvelope(error)
  }
}
