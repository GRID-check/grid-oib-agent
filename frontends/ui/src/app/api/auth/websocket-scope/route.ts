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
import type { AuthorizedSession } from '@/lib/auth/types'
import { isAuthzError } from '@/lib/auth-utils'

const isAuthRequired = (): boolean => {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

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

    if (projectId) {
      if (isAuthRequired() && session) {
        await requireProjectAccess(session as AuthorizedSession, projectId, 'project:view')
      }
      const projectContext = await loadProjectPromptView(projectId)
      if (projectContext) {
        response.projectContext = projectContext
      }
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


