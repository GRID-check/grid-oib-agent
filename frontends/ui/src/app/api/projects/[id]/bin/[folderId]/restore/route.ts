/**
 * Restore a folder from the Papierkorb with its access, subfolders and
 * documents (ADR-0088). `restoredTo: 'root'` when its parent is gone.
 */

import { apiRoute } from '@/lib/api/handler'
import { restoreFolderFromBin } from '@/lib/projects/folder-bin'

type Params = { id: string; folderId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) =>
    restoreFolderFromBin(session, { projectId: params.id, folderId: params.folderId }, request),
  { authz: { enforcedBy: 'restoreFolderFromBin (project:documents:write; write on the deleted folder)' } }
)
