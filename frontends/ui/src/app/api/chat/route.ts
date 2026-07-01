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

import { NextResponse } from 'next/server'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import type { GridSession } from '@/lib/auth/types'

const isAuthRequired = (): boolean => {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

const isAuthzError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message === 'not found' ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  )
}

const getBackendUrl = (): string => {
  const url = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}

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
      const headerToken = req.headers.get('Authorization')
      authHeader = headerToken || (session.accessToken ? `Bearer ${session.accessToken}` : null)
    }

    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      projectId: body.projectId,
      conversationId: body.conversationId,
    })

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
        ...(authHeader ? { Authorization: authHeader } : {}),
        'X-Grid-Collection-Scope': headerValue,
      },
      body: JSON.stringify(body),
    })

    console.log('[Chat API] Backend response status:', response.status)

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text()
      console.error('[Chat API] Backend error:', errorText)

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

    // Check if we have a response body
    if (!response.body) {
      return new NextResponse(
        JSON.stringify({
          error: {
            code: 'NO_RESPONSE_BODY',
            message: 'Backend returned no response body',
          },
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    // Stream the response back to the client
    // We pass through the SSE stream unchanged
    return new NextResponse(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
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

    console.error('[Chat API] Proxy error:', error)

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
