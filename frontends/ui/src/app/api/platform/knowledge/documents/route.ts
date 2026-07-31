/**
 * Platform knowledge management — upload a PDF (or a ZIP of PDFs) into the
 * shared base corpus (ADR-0016). Platform owners only. The backend ingests in
 * the background, so a successful accept returns `pending` (HTTP 200); the UI
 * polls the corpus status for the terminal lifecycle. An optional `doc_class`
 * form field pre-sets the Dokumentart for a single-PDF upload.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { uploadKnowledgeBaseDocument } from '@/lib/knowledge/service'

export const POST = platformApiRoute(async ({ request }) => {
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'A PDF or ZIP file is required', code: 'BAD_REQUEST' },
      { status: 400 }
    )
  }
  const docClassField = form?.get('doc_class')
  const docClass =
    typeof docClassField === 'string' && docClassField.trim() ? docClassField.trim() : undefined

  const result = await uploadKnowledgeBaseDocument(file, { docClass })
  // Ingestion is backgrounded: 'pending' (accepted) and 'success' are OK;
  // only a terminal 'failed'/'timeout' maps to a gateway error the UI surfaces.
  const ok = result.status === 'pending' || result.status === 'success'
  return NextResponse.json(result, { status: ok ? 200 : 502 })
})
