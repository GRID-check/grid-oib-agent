/**
 * Resolve an Archiv folder upload's directory paths to folder ids, creating what
 * is missing — the twin of `/api/projects/[id]/folders/ensure`, with the same
 * handler (`@/lib/documents/folder-route-handlers`). Authz and logic live in
 * `@/lib/archiv/folder-service` (`org:archiv:manage`). Feature-gated by the
 * dark-launch `organization-archiv` flag (ADR-0024, ADR-0078).
 */

import { apiRoute } from '@/lib/api/handler'
import { requireArchivFeature } from '@/lib/archiv/feature-gate'
import { ensureFoldersHandler } from '@/lib/documents/folder-route-handlers'
import { ensureArchivFolderPaths } from '@/lib/archiv/folder-service'

export const POST = apiRoute(
  ensureFoldersHandler<unknown>((_params, session, input) => ensureArchivFolderPaths(session, input), requireArchivFeature),
  { authz: { enforcedBy: 'ensureArchivFolderPaths (canManageArchiv)' } }
)
