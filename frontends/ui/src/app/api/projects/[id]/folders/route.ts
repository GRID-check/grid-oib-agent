/**
 * Project folders API — list and create folders for a project.
 * Thin handlers; the request handling is shared with the Archiv's folders
 * (`@/lib/documents/folder-route-handlers`) and authz and logic live in
 * `@/lib/projects/folder-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { createFolderHandler } from '@/lib/documents/folder-route-handlers'
import { createProjectFolder, listProjectFolders, projectRootAccess } from '@/lib/projects/folder-service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const folders = await listProjectFolders(params.id, session)
    // What the reader may do at the project root (ADR-0087): the project's
    // document-write permission alone. Each folder carries its own `access`.
    return { folders, rootAccess: await projectRootAccess(session, params.id) }
  },
  { authz: { enforcedBy: 'listProjectFolders (requireProjectAccess project:view; folder read access)' } }
)

export const POST = apiRoute<Params>(
  createFolderHandler<Params>((params, session, input) =>
    createProjectFolder({ projectId: params.id, ...input }, session)
  ),
  {
    status: 201,
    authz: { enforcedBy: 'createProjectFolder (requireFolderWrite: project:documents:write + write on the parent)' },
  }
)
