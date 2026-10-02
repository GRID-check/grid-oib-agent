/**
 * Restrict a project folder to WorkOS roles, or open it again (ADR-0078).
 *
 * PUT { roles: string[] | null } — `project:manage`. The documents below the
 * folder move into the collection the new restriction puts them in before the
 * response returns; `failed` lists any that could not move this time, and
 * repeating the request retries exactly those.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { FOLDER_RESTRICTION_MAX_ROLES, setFolderRestriction } from '@/lib/projects/folder-restriction'

type Params = { id: string; folderId: string }

const bodySchema = z
  .object({
    roles: z.array(z.string().trim().min(1).max(100)).max(FOLDER_RESTRICTION_MAX_ROLES).nullable(),
  })
  .strict()

export const PUT = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { roles } = await parseJsonBody(request, bodySchema)
    return setFolderRestriction(session, { projectId: params.id, folderId: params.folderId, roles }, request)
  },
  { authz: { enforcedBy: 'setFolderRestriction -> requireProjectAccess (project:manage) + folder visibility' } }
)
