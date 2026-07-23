/**
 * Platform knowledge management — rename a base-corpus document (user-facing
 * display title). Platform owners only. Because retrieval is store-authoritative
 * for the display title, the change reflects on citation chips immediately with
 * no re-ingest. An empty/null title clears the override, restoring the default.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { ApiError } from '@/lib/api/errors'
import { updateKnowledgeBaseDisplayTitle } from '@/lib/knowledge/service'

export async function PATCH(
  request: Request,
  context: { params: Promise<{ fileName: string }> },
): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)

    const { fileName } = await context.params
    const body = (await request.json().catch(() => null)) as { display_title?: unknown } | null
    const raw = typeof body?.display_title === 'string' ? body.display_title.trim() : ''
    const displayTitle = raw || null

    await updateKnowledgeBaseDisplayTitle(fileName, displayTitle)
    return NextResponse.json({ fileName, displayTitle })
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
