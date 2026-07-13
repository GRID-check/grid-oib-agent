/**
 * Platform knowledge management — remove an admin-uploaded PDF from the
 * shared base corpus (source file, registry entry, indexed chunks).
 * Platform owners only. Repo-shipped corpus files cannot be deleted.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { ApiError } from '@/lib/api/errors'
import { deleteKnowledgeBaseDocument } from '@/lib/knowledge/service'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ fileName: string }> },
): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)

    const { fileName } = await context.params
    await deleteKnowledgeBaseDocument(fileName)
    return NextResponse.json({ success: true, fileName })
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
