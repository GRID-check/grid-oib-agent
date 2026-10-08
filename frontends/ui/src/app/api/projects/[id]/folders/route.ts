/**
 * Project folders API — list and create folders for a project.
 * Thin handlers; the request handling is shared with the Archiv's folders
 * (`@/lib/documents/folder-route-handlers`) and authz and logic live in
 * `@/lib/projects/folder-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { createFolderHandler, listFoldersHandler } from '@/lib/documents/folder-route-handlers'
import { createProjectFolder, listProjectFolders } from '@/lib/projects/folder-service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  listFoldersHandler<Params>((params, session) => listProjectFolders(params.id, session)),
  { authz: { enforcedBy: 'listProjectFolders (requireProjectAccess project:view)' } }
)

export const POST = apiRoute<Params>(
  createFolderHandler<Params>((params, session, input) =>
    createProjectFolder({ projectId: params.id, ...input }, session)
  ),
  {
    status: 201,
    authz: { enforcedBy: 'createProjectFolder (requireProjectAccess project:documents:write)' },
  }
)
