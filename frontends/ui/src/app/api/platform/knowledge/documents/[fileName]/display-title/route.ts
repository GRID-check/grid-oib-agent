/**
 * Platform knowledge management — rename a base-corpus document (user-facing
 * display title). Platform owners only. Because retrieval is store-authoritative
 * for the display title, the change reflects on citation chips immediately with
 * no re-ingest. An empty/null title clears the override, restoring the default.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { updateKnowledgeBaseDisplayTitle } from '@/lib/knowledge/service'

export const PATCH = platformApiRoute<{ fileName: string }>(
  async ({ request, params }) => {
    const { fileName } = params
    const body = (await request.json().catch(() => null)) as { display_title?: unknown } | null
    const raw = typeof body?.display_title === 'string' ? body.display_title.trim() : ''
    const displayTitle = raw || null

    await updateKnowledgeBaseDisplayTitle(fileName, displayTitle)
    return NextResponse.json({ fileName, displayTitle })
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
