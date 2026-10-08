/**
 * One project folder — rename, move, delete.
 *
 * Thin handlers; the request handling is shared with the Archiv's folders
 * (`@/lib/documents/folder-route-handlers`, where the delete's re-filing is
 * explained) and authz and logic live in `@/lib/projects/folder-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { deleteFolderHandler, updateFolderHandler } from '@/lib/documents/folder-route-handlers'
import { deleteProjectFolder, updateProjectFolder } from '@/lib/projects/folder-service'

type Params = { id: string; folderId: string }

export const PATCH = apiRoute<Params>(
  updateFolderHandler<Params>((params, session, patch) =>
    updateProjectFolder({ projectId: params.id, folderId: params.folderId, ...patch }, session)
  ),
  { authz: { enforcedBy: 'updateProjectFolder (requireProjectAccess project:documents:write)' } }
)

export const DELETE = apiRoute<Params>(
  deleteFolderHandler<Params>((params, session) =>
    deleteProjectFolder({ projectId: params.id, folderId: params.folderId }, session)
  ),
  { authz: { enforcedBy: 'deleteProjectFolder (requireProjectAccess project:documents:write)' } }
)
