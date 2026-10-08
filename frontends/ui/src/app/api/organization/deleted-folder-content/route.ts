/**
 * Organisation → Sensible Daten → „Inhalte aus gelöschten Ordnern" (ADR-0087):
 * who sees chats, answers and notes drawn from a folder once it is purged.
 *
 * GET — any member: the settings page shows the choice to everyone, and the
 *       Papierkorb says what a purge will do.
 * PUT — `org:settings:manage`. The only writer of
 *       `settings.deletedFolderContent`; audited.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { deletedFolderContentSchema, getDeletedFolderContentPolicy } from '@/lib/organizations/deleted-folder-content'
import { saveDeletedFolderContentPolicy } from '@/lib/organizations/deleted-folder-content-service'

export const GET = apiRoute(
  async ({ session }) => ({ policy: await getDeletedFolderContentPolicy(session.organizationId) }),
  {
    authz: {
      sessionOnly: true,
      why: "every member reads their own organization's choice (it says what a purge does to derived content); keyed by session.organizationId, and the write requires org:settings:manage below",
    },
  }
)

export const PUT = apiRoute(
  async ({ session, request }) => {
    const { policy } = await parseJsonBody(request, deletedFolderContentSchema)
    return { policy: await saveDeletedFolderContentPolicy(session, policy, request) }
  },
  { authz: { permission: ORG_PERMISSIONS.settingsManage } }
)
