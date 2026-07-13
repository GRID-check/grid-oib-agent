/**
 * Platform knowledge management — upload a PDF into the shared base corpus
 * (ADR-0016). Platform owners only; the backend ingests it synchronously so
 * the corpus list reflects the outcome immediately.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse } from '@/lib/auth/require-auth'
import { getGridSession } from '@/lib/auth/session'
import { PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import { ApiError } from '@/lib/api/errors'
import { uploadKnowledgeBaseDocument } from '@/lib/knowledge/service'

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getGridSession()
    await requirePlatformOwner(session)

    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'A PDF file is required', code: 'BAD_REQUEST' }, { status: 400 })
    }

    const result = await uploadKnowledgeBaseDocument(file)
    return NextResponse.json(result, { status: result.status === 'success' ? 200 : 502 })
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
