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
import { and, eq } from 'drizzle-orm'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import type { GridSession, AuthorizedSession } from '@/lib/auth/types'
import { isAuthzError } from '@/lib/auth-utils'
import {
  getBackendUrl,
  resolveOptionalSession,
  errorEnvelope,
  backendErrorEnvelope,
  handleAuthzError,
  proxyErrorEnvelope,
} from '@/lib/backend-proxy'

const buildBackendUrl = (path: string[], searchParams?: URLSearchParams): string => {
  const backendBase = getBackendUrl()
  const pathString = path.join('/')
  const url = new URL(`${backendBase}/v1/${pathString}`)
  searchParams?.forEach((value, key) => {
    url.searchParams.set(key, value)
  })
  return url.toString()
}

const isRedirectError = (error: unknown): boolean => {
  return error instanceof Error && error.message === 'NEXT_REDIRECT'
}

const errorResponse = errorEnvelope
const resolveSession = resolveOptionalSession

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

function normalizeSessionCollectionName(value: string): string {
  return value.startsWith('s_') ? value : `s_${value}`
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
    if (!session?.organizationId) {
      return handleAuthzError(new Error('Forbidden'))
    }
    try {
      const db = getDb()
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.collectionName, collectionName), eq(projects.organizationId, session.organizationId)))
        .limit(1)

      if (!project) {
        return handleAuthzError(new Error('Not found'))
      }

      await requireProjectAccess(session as AuthorizedSession, project.id, 'project:edit')
    } catch (error) {
      return handleAuthzError(error)
    }
    return null
  }

  if (collectionName.startsWith('s_')) {
    if (!context.conversationId || normalizeSessionCollectionName(context.conversationId) !== collectionName) {
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
      return backendErrorEnvelope(response.status, errorText)
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

    return proxyErrorEnvelope(error)
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
