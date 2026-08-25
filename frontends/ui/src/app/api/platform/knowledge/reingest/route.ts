/**
 * Platform knowledge management — rebuild the chunks of SELECTED base-corpus
 * documents. Platform owners only.
 *
 * Distinct from `../sync`: that one is incremental and gates on the sha256 of each
 * PDF, so it is a no-op for a document whose file has not changed. This one forces
 * the rebuild, which is what an admin needs after a change to how chunks are built
 * rather than to what they are built from.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { reingestKnowledgeBaseDocuments } from '@/lib/knowledge/service'

const bodySchema = z.object({
  fileNames: z.array(z.string()).min(1),
})

export const POST = platformApiRoute(
  async ({ request }) => {
    const { fileNames } = await parseJsonBody(request, bodySchema)
    const result = await reingestKnowledgeBaseDocuments(fileNames)
    return NextResponse.json(result)
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
