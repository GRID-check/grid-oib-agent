/**
 * Internal WebSocket Collection Scope Endpoint
 *
 * Called by server.js during the WebSocket upgrade handshake. It resolves the
 * current Grid session from the encrypted WorkOS cookie, builds the ordered
 * collection scope, and returns the base64url-encoded header value.
 */

import { NextResponse } from 'next/server'
import { getGridSession } from '@/lib/auth/session'
import { requireProjectAccess } from '@/lib/authz/projects'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { isOrgFeatureEnabled, MEMORY_REFLECTION_FLAG } from '@/lib/workos/feature-flags'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isAuthzError } from '@/lib/auth-utils'

const isAuthRequired = (): boolean => {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

/**
 * Fallback for anonymous / non-WorkOS deployments: when no org is in scope the
 * feature flag can't be evaluated, so honour an env opt-in instead.
 */
const memoryReflectionEnvDefault = (): boolean =>
  process.env.MEMORY_REFLECTION_ENABLED?.toLowerCase() === 'true'

export async function GET(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId') || undefined
    const conversationId = searchParams.get('conversationId') || undefined

    const session = await getGridSession()

    if (isAuthRequired() && !session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { scope, headerValue } = await buildCollectionScopeFromRequest(session, {
      projectId,
      conversationId,
    })

    const response: Record<string, unknown> = {
      scope,
      header: headerValue,
    }

    if (session) {
      response.organizationId = session.organizationId
      response.userId = session.userId
      response.accessToken = session.accessToken
    }

    // Gate the async memory-reflection stage on a WorkOS feature flag
    // ("memory-reflection") evaluated for the caller's org; fall back to the
    // MEMORY_REFLECTION_ENABLED env opt-in when there is no org (anonymous
    // mode). Fail-closed. server.js forwards this as x-grid-feature-memory-reflection.
    response.memoryReflectionEnabled = session?.organizationId
      ? await isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, session.organizationId, memoryReflectionEnvDefault())
      : memoryReflectionEnvDefault()

    if (projectId) {
      if (isAuthRequired() && session) {
        await requireProjectAccess(session as AuthorizedSession, projectId, 'project:view')
      }
      // Residual exposure: when REQUIRE_AUTH is off (anonymous single-tenant
      // deployments) there is no session, so the caller-supplied projectId
      // reaches loadProjectPromptView and the memory digest unchecked. The
      // service layer pins queries to session.organizationId whenever a
      // session exists (defense-in-depth); fully gating anonymous mode is a
      // product decision.
      response.projectId = projectId
      const projectContext = await loadProjectPromptView(projectId)
      if (projectContext) {
        response.projectContext = projectContext
      }
    }

    // Core memory digest (bounded) — becomes x-grid-project-memory on the WS
    // upgrade. Merges project items with org-wide items; org knowledge applies
    // even outside a project-scoped chat. Best-effort: memory must never block
    // the chat handshake.
    try {
      const projectMemory = await buildProjectMemoryDigest(projectId, session?.organizationId ?? undefined)
      if (projectMemory) {
        response.projectMemory = projectMemory
      }
    } catch (error) {
      console.warn('[WebSocket Scope API] Failed to build project memory digest:', error)
    }

    return NextResponse.json(response, { status: 200 })
  } catch (error) {
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    console.error('[WebSocket Scope API] Error:', error)

    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    )
  }
}


