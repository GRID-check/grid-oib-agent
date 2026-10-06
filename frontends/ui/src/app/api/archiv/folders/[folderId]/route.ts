/**
 * One Archiv folder — rename, move, delete.
 *
 * The twin of `/api/projects/[id]/folders/[folderId]`, with the same handlers
 * (`@/lib/documents/folder-route-handlers`). Authz and logic live in
 * `@/lib/archiv/folder-service` (`org:archiv:manage`). Feature-gated by the
 * dark-launch `organization-archiv` flag (ADR-0024, ADR-0078).
 */

import { apiRoute } from '@/lib/api/handler'
import { requireArchivFeature } from '@/lib/archiv/feature-gate'
import { deleteFolderHandler, updateFolderHandler } from '@/lib/documents/folder-route-handlers'
import { deleteArchivFolder, updateArchivFolder } from '@/lib/archiv/folder-service'

type Params = { folderId: string }

export const PATCH = apiRoute<Params>(
  updateFolderHandler<Params>(
    (params, session, patch) => updateArchivFolder(session, { folderId: params.folderId, ...patch }),
    requireArchivFeature,
  ),
  { authz: { enforcedBy: 'updateArchivFolder (canManageArchiv)' } }
)

export const DELETE = apiRoute<Params>(
  deleteFolderHandler<Params>((params, session) => deleteArchivFolder(session, params.folderId), requireArchivFeature),
  { authz: { enforcedBy: 'deleteArchivFolder (canManageArchiv)' } }
)
