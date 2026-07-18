/**
 * Platform knowledge management — reclassify a base-corpus document's
 * Dokumentart (doc_class). Platform owners only. Because retrieval is
 * store-authoritative for doc_class, the change reflects immediately with no
 * re-ingest.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { ApiError } from '@/lib/api/errors'
import { updateKnowledgeBaseDocClass } from '@/lib/knowledge/service'

export async function PATCH(
  request: Request,
  context: { params: Promise<{ fileName: string }> },
): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)

    const { fileName } = await context.params
    const body = (await request.json().catch(() => null)) as { doc_class?: unknown } | null
    const docClass = typeof body?.doc_class === 'string' ? body.doc_class : ''
    if (!docClass) {
      return NextResponse.json({ error: 'A doc_class is required', code: 'BAD_REQUEST' }, { status: 400 })
    }

    await updateKnowledgeBaseDocClass(fileName, docClass)
    return NextResponse.json({ fileName, docClass })
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
