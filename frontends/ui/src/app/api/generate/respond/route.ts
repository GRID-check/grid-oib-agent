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

const isAuthRequired = (): boolean => {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

const getBackendUrl = (): string => {
  const url = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const authRequired = isAuthRequired()

    let session: GridSession | null = null
    let authHeader: string | null = null
    if (authRequired) {
      session = await requireAuthorizedSession()
      const headerToken = req.headers.get('Authorization')
      authHeader = headerToken || (session.accessToken ? `Bearer ${session.accessToken}` : null)
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
        ...(authHeader ? { Authorization: authHeader } : {}),
        'X-Grid-Collection-Scope': headerValue,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Generate Respond API] Backend error:', errorText)

      return new NextResponse(
        JSON.stringify({
          error: {
            code: 'BACKEND_ERROR',
            message: `Backend returned ${response.status}: ${errorText}`,
          },
        }),
        {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const data = await response.json().catch(() => ({}))
    return NextResponse.json(data)
  } catch (error) {
    if (isAuthzError(error)) {
      const status = error instanceof Error && error.message.toLowerCase() === 'not found' ? 404 : 403
      const code = status === 404 ? 'NOT_FOUND' : 'FORBIDDEN'

      return new NextResponse(
        JSON.stringify({
          error: {
            code,
            message: error instanceof Error ? error.message : 'Access denied',
          },
        }),
        {
          status,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    console.error('[Generate Respond API] Proxy error:', error)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    return new NextResponse(
      JSON.stringify({
        error: {
          code: 'PROXY_ERROR',
          message: errorMessage,
        },
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
