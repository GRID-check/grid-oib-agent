/**
 * Resolve a folder upload's directory paths to folder ids, creating what is
 * missing. Thin handler; the request handling is shared with the Archiv's
 * (`@/lib/documents/folder-route-handlers`, where why this is not the create
 * endpoint with a loop in front of it is written down) and the matching and the
 * get-or-create races live in `@/lib/projects/folder-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { ensureFoldersHandler } from '@/lib/documents/folder-route-handlers'
import { ensureProjectFolderPaths } from '@/lib/projects/folder-service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  ensureFoldersHandler<Params>((params, session, input) =>
    ensureProjectFolderPaths({ projectId: params.id, ...input }, session)
  ),
  {
    authz: {
      enforcedBy: 'ensureProjectFolderPaths (requireProjectAccess project:documents:write)',
    },
  },
)
