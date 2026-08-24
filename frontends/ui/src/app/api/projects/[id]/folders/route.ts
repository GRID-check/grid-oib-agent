/**
 * Project folders API — list and create folders for a project.
 * Thin handlers; authz and logic live in `@/lib/projects/folder-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { createProjectFolder, listProjectFolders } from '@/lib/projects/folder-service'

type Params = { id: string }

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().nullable().optional(),
})

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({
    folders: await listProjectFolders(params.id, session),
  }),
  { authz: { enforcedBy: 'listProjectFolders (requireProjectAccess project:view)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { name, parentId } = await parseJsonBody(request, createFolderSchema)
    const result = await createProjectFolder(
      { projectId: params.id, name, parentId: parentId ?? null },
      session
    )
    if (!result.ok) throw new BadRequestError(result.error)
    return { folder: result.folder }
  },
  {
    status: 201,
    authz: { enforcedBy: 'createProjectFolder (requireProjectAccess project:documents:write)' },
  }
)
