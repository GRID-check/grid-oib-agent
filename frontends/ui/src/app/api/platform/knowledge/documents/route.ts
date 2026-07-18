/**
 * Platform knowledge management — upload a PDF (or a ZIP of PDFs) into the
 * shared base corpus (ADR-0016). Platform owners only. The backend ingests in
 * the background, so a successful accept returns `pending` (HTTP 200); the UI
 * polls the corpus status for the terminal lifecycle. An optional `doc_class`
 * form field pre-sets the Dokumentart for a single-PDF upload.
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
      return NextResponse.json({ error: 'A PDF or ZIP file is required', code: 'BAD_REQUEST' }, { status: 400 })
    }
    const docClassField = form?.get('doc_class')
    const docClass = typeof docClassField === 'string' && docClassField.trim() ? docClassField.trim() : undefined

    const result = await uploadKnowledgeBaseDocument(file, { docClass })
    // Ingestion is backgrounded: 'pending' (accepted) and 'success' are OK;
    // only a terminal 'failed'/'timeout' maps to a gateway error the UI surfaces.
    const ok = result.status === 'pending' || result.status === 'success'
    return NextResponse.json(result, { status: ok ? 200 : 502 })
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
