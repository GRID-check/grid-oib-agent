/**
 * Saving „Inhalte aus gelöschten Ordnern" (ADR-0081): the one writer of
 * `organizations.settings.deletedFolderContent` (the generic settings save
 * refuses the key, `DEDICATED_ROUTE_SETTINGS`), audited.
 */

import 'server-only'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DeletedFolderContentPolicy } from '@/lib/authz/folder-access-rule'
import { writeDedicatedOrgSetting } from './service'
import { DELETED_FOLDER_CONTENT_SETTING, invalidateDeletedFolderContentPolicy } from './deleted-folder-content'

/** Save the organization's choice (validated by the route) and audit who changed it. */
export async function saveDeletedFolderContentPolicy(
  session: AuthorizedSession,
  policy: DeletedFolderContentPolicy,
  request: Request
): Promise<DeletedFolderContentPolicy> {
  await writeDedicatedOrgSetting(session.organizationId, DELETED_FOLDER_CONTENT_SETTING, policy)
  await invalidateDeletedFolderContentPolicy(session.organizationId)
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.deleted_folder_content.updated',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { policy },
    request,
  })
  return policy
}
