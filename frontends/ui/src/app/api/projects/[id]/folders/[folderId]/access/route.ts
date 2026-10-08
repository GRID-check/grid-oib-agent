/**
 * Who may read and who may write a project folder (ADR-0085).
 *
 * PUT `{ mode: 'inherit' }` or `{ mode: 'custom', grants: [{ role, level }] }`
 * — `project:manage`. `role` is a WorkOS role slug of the organization, or `*`
 * for every project member; `level` is `read` or `write`. A change of who may
 * READ moves the documents below the folder into the collection the new access
 * puts them in before the response returns; `failed` lists any that could not
 * move this time, and repeating the request retries exactly those.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { FOLDER_ACCESS_MAX_GRANTS, setFolderAccess } from '@/lib/projects/folder-access-settings'

type Params = { id: string; folderId: string }

const grantSchema = z
  .object({
    role: z.string().trim().min(1).max(100),
    level: z.enum(['read', 'write']),
  })
  .strict()

const bodySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z
    .object({
      mode: z.literal('custom'),
      grants: z.array(grantSchema).min(1).max(FOLDER_ACCESS_MAX_GRANTS),
    })
    .strict(),
])

export const PUT = apiRoute<Params>(
  async ({ session, params, request }) => {
    const access = await parseJsonBody(request, bodySchema)
    return setFolderAccess(session, { projectId: params.id, folderId: params.folderId, access }, request)
  },
  { authz: { enforcedBy: 'setFolderAccess -> requireProjectAccess (project:manage) + folder read access' } }
)
