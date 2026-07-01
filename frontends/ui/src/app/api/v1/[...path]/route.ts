// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
 * - Validates collection_name for collection-scoped routes (e.g. uploads).
 */

import { NextResponse } from 'next/server'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { GridSession, AuthorizedSession } from '@/lib/auth/types'

const isAuthRequired = (): boolean => {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

const getBackendUrl = (): string => {
  const url = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}

const buildBackendUrl = (path: string[], searchParams?: URLSearchParams): string => {
  const backendBase = getBackendUrl()
  const pathString = path.join('/')
  const url = new URL(`${backendBase}/v1/${pathString}`)
  searchParams?.forEach((value, key) => {
    url.searchParams.set(key, value)
  })
  return url.toString()
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

const isRedirectError = (error: unknown): boolean => {
  return error instanceof Error && error.message === 'NEXT_REDIRECT'
}

const handleAuthzError = (error: unknown): NextResponse => {
  const status = error instanceof Error && error.message.toLowerCase() === 'not found' ? 404 : 403
  const code = status === 404 ? 'NOT_FOUND' : 'FORBIDDEN'

  return new NextResponse(
    JSON.stringify({
      error: {
        code,
        message: error instanceof Error ? error.message : 'Access denied',
      },
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  )
}

const errorResponse = (status: number, code: string, message: string): NextResponse => {
  return new NextResponse(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { 'Content-Type': 'application/json' } }
  )
}

async function resolveSession(): Promise<GridSession | null> {
  if (!isAuthRequired()) {
    return null
  }
  return requireAuthorizedSession()
}

function parseQueryContext(searchParams: URLSearchParams): { projectId?: string; conversationId?: string } {
  return {
    projectId: searchParams.get('projectId') || undefined,
    conversationId: searchParams.get('conversationId') || undefined,
  }
}

function resolveRequestContext(
  searchParams: URLSearchParams,
  parsedBody?: Record<string, unknown>
): { projectId?: string; conversationId?: string } {
  const queryContext = parseQueryContext(searchParams)

  if (!parsedBody) {
    return queryContext
  }

  return {
    projectId: typeof parsedBody.projectId === 'string' ? parsedBody.projectId : queryContext.projectId,
    conversationId:
      typeof parsedBody.conversationId === 'string'
        ? parsedBody.conversationId
        : typeof parsedBody.session_id === 'string'
          ? parsedBody.session_id
          : queryContext.conversationId,
  }
}

async function validateCollectionName(
  path: string[],
  session: GridSession | null,
  context: { projectId?: string; conversationId?: string }
): Promise<Response | null> {
  if (path.length < 2 || path[0] !== 'collections') {
    return null
  }

  const collectionName = path[1]
  const baseName = process.env.BASE_COLLECTION_NAME || 'oib_knowledge'

  if (collectionName === baseName) {
    return errorResponse(400, 'INVALID_COLLECTION', 'Uploads to the base corpus are not allowed')
  }

  if (collectionName.startsWith('proj_')) {
    const projectId = collectionName.slice('proj_'.length)
    if (!session) {
      return handleAuthzError(new Error('Forbidden'))
    }
    try {
      await requireProjectAccess(session as AuthorizedSession, projectId, 'project:edit')
    } catch (error) {
      return handleAuthzError(error)
    }
    return null
  }

  if (collectionName.startsWith('s_')) {
    const conversationId = collectionName.slice('s_'.length)
    if (!context.conversationId || context.conversationId !== conversationId) {
      return errorResponse(400, 'INVALID_COLLECTION', 'Collection does not match active conversation')
    }
    return null
  }

  return errorResponse(400, 'INVALID_COLLECTION', 'Invalid collection name')
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const { searchParams } = new URL(req.url)
    const session = await resolveSession()
    const context = parseQueryContext(searchParams)

    const validationError = await validateCollectionName(path, session, context)
    if (validationError) {
      return validationError
    }

    const { headerValue } = await buildCollectionScopeFromRequest(session, context)
    const authHeaders: Record<string, string> = session ? { Authorization: `Bearer ${session.accessToken}` } : {}

    const response = await fetch(buildBackendUrl(path, searchParams), {
      method: 'GET',
      headers: {
        ...authHeaders,
        Accept: 'application/json',
        'X-Grid-Collection-Scope': headerValue,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      return new NextResponse(
        JSON.stringify({
          error: { code: 'BACKEND_ERROR', message: `Backend returned ${response.status}: ${errorText}` },
        }),
        { status: response.status, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    if (isRedirectError(error)) {
      throw error
    }
    if (isAuthzError(error)) {
      return handleAuthzError(error)
    }

    const message = error instanceof Error ? error.message : 'Unknown error'
    return new NextResponse(
      JSON.stringify({ error: { code: 'PROXY_ERROR', message } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const { searchParams } = new URL(req.url)
    const session = await resolveSession()
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
    const authHeaders: Record<string, string> = session ? { Authorization: `Bearer ${session.accessToken}` } : {}

    const response = await fetch(buildBackendUrl(path, searchParams), {
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
      return new NextResponse(
        JSON.stringify({
          error: { code: 'BACKEND_ERROR', message: `Backend returned ${response.status}: ${errorText}` },
        }),
        { status: response.status, headers: { 'Content-Type': 'application/json' } }
      )
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

    const message = error instanceof Error ? error.message : 'Unknown error'
    return new NextResponse(
      JSON.stringify({ error: { code: 'PROXY_ERROR', message } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const { searchParams } = new URL(req.url)
    const session = await resolveSession()
    const context = parseQueryContext(searchParams)

    const validationError = await validateCollectionName(path, session, context)
    if (validationError) {
      return validationError
    }

    const { headerValue } = await buildCollectionScopeFromRequest(session, context)
    const authHeaders: Record<string, string> = session ? { Authorization: `Bearer ${session.accessToken}` } : {}

    let body: string | undefined
    try {
      const json = await req.json()
      body = JSON.stringify(json)
    } catch {
      body = undefined
    }

    const response = await fetch(buildBackendUrl(path, searchParams), {
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
      return new NextResponse(
        JSON.stringify({
          error: { code: 'BACKEND_ERROR', message: `Backend returned ${response.status}: ${errorText}` },
        }),
        { status: response.status, headers: { 'Content-Type': 'application/json' } }
      )
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

    const message = error instanceof Error ? error.message : 'Unknown error'
    return new NextResponse(
      JSON.stringify({ error: { code: 'PROXY_ERROR', message } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
