/**
 * One project folder — rename, move, delete.
 *
 * Thin handlers; the request handling is shared with the Archiv's folders
 * (`@/lib/documents/folder-route-handlers`, where the delete's re-filing is
 * explained) and authz and logic live in `@/lib/projects/folder-service`. A
 * project folder's delete keeps the row as a tombstone (ADR-0088): deleting a
 * label must not delete the work filed under it, nor the access that decides
 * who may read what was derived from it.
 */

import { apiRoute } from '@/lib/api/handler'
import { deleteFolderHandler, updateFolderHandler } from '@/lib/documents/folder-route-handlers'
import { deleteProjectFolder, updateProjectFolder } from '@/lib/projects/folder-service'

type Params = { id: string; folderId: string }

export const PATCH = apiRoute<Params>(
  updateFolderHandler<Params>((params, session, patch, request) =>
    updateProjectFolder({ projectId: params.id, folderId: params.folderId, ...patch }, session, request)
  ),
  {
    authz: {
      enforcedBy:
        'updateProjectFolder (requireFolderWrite: project:documents:write + write on the folder and the new parent; project:manage when the move changes an access list over the subtree)',
    },
  }
)

export const DELETE = apiRoute<Params>(
  deleteFolderHandler<Params>((params, session, request) =>
    deleteProjectFolder({ projectId: params.id, folderId: params.folderId }, session, request)
  ),
  {
    authz: {
      enforcedBy:
        'deleteProjectFolder (requireFolderWrite: project:documents:write + write on the folder and its child folders; project:manage for a folder with its own access list)',
    },
  }
)
