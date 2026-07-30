/**
 * Platform knowledge management — trigger an incremental base-corpus re-sync
 * (new/changed PDFs are re-ingested). Platform owners only.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { syncKnowledgeBase } from '@/lib/knowledge/service'

export const POST = platformApiRoute(async () => {
  const result = await syncKnowledgeBase()
  return NextResponse.json(result)
})
