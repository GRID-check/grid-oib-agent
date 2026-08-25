/**
 * Platform knowledge management — remove an admin-uploaded PDF from the
 * shared base corpus (source file, registry entry, indexed chunks).
 * Platform owners only. Repo-shipped corpus files cannot be deleted.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { deleteKnowledgeBaseDocument } from '@/lib/knowledge/service'

export const DELETE = platformApiRoute<{ fileName: string }>(
  async ({ params }) => {
    const { fileName } = params
    await deleteKnowledgeBaseDocument(fileName)
    return NextResponse.json({ success: true, fileName })
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
