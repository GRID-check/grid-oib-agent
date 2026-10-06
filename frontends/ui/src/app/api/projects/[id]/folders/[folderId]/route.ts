/**
 * One project folder — rename, move, delete.
 *
 * Thin handlers; authz and logic live in `@/lib/projects/folder-service`. The
 * rename and move share their request handling with the Archiv's folders
 * (`@/lib/documents/folder-route-handlers`). The delete does not: a project
 * folder goes to the Papierkorb with its subfolders and their documents
 * (`@/lib/projects/folder-bin`, ADR-0081), restorable with its access for
 * `FOLDER_PURGE_GRACE_DAYS`, then purged to a tombstone. It answers
 * `{ documentsBinned, foldersBinned, purgeAfter }`, not the Archiv's re-filing
 * counts.
 */

import { apiRoute } from '@/lib/api/handler'
import { updateFolderHandler } from '@/lib/documents/folder-route-handlers'
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
  async ({ session, params, request }) =>
    deleteProjectFolder({ projectId: params.id, folderId: params.folderId }, session, request),
  {
    authz: {
      enforcedBy:
        'deleteProjectFolder → moveFolderToBin (project:documents:write, write on the folder and on every folder below it)',
    },
  }
)
