/**
 * Platform knowledge management — reclassify a base-corpus document's
 * Dokumentart (doc_class). Platform owners only. Because retrieval is
 * store-authoritative for doc_class, the change reflects immediately with no
 * re-ingest.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { updateKnowledgeBaseDocClass } from '@/lib/knowledge/service'

export const PATCH = platformApiRoute<{ fileName: string }>(
  async ({ request, params }) => {
    const { fileName } = params
    const body = (await request.json().catch(() => null)) as { doc_class?: unknown } | null
    const docClass = typeof body?.doc_class === 'string' ? body.doc_class : ''
    if (!docClass) {
      return NextResponse.json(
        { error: 'A doc_class is required', code: 'BAD_REQUEST' },
        { status: 400 }
      )
    }

    await updateKnowledgeBaseDocClass(fileName, docClass)
    return NextResponse.json({ fileName, docClass })
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
