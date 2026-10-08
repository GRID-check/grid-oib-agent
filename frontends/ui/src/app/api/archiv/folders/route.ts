/**
 * Archiv folders API — list and create folders in the org-wide Archiv.
 *
 * The twin of `/api/projects/[id]/folders`, with the same handlers
 * (`@/lib/documents/folder-route-handlers`) and the same response shapes.
 * Authz and logic live in `@/lib/archiv/folder-service`: any member reads, and
 * creating takes `org:archiv:manage`. Feature-gated by the dark-launch
 * `organization-archiv` flag (ADR-0024, ADR-0078).
 */

import { apiRoute } from '@/lib/api/handler'
import { requireArchivFeature } from '@/lib/archiv/feature-gate'
import { createFolderHandler, listFoldersHandler } from '@/lib/documents/folder-route-handlers'
import { createArchivFolder, listArchivFolders } from '@/lib/archiv/folder-service'

export const GET = apiRoute(
  listFoldersHandler<unknown>((_params, session) => listArchivFolders(session), requireArchivFeature),
  {
    authz: {
      sessionOnly: true,
      why: 'the Archiv is org-wide shared knowledge; listArchivFolders scopes to session.organizationId and any member may read it, like listArchiv',
    },
  }
)

export const POST = apiRoute(
  createFolderHandler<unknown>((_params, session, input) => createArchivFolder(session, input), requireArchivFeature),
  {
    status: 201,
    authz: { enforcedBy: 'createArchivFolder (canManageArchiv)' },
  }
)
