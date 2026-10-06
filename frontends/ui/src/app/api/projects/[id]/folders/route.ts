/**
 * Project folders API — list and create folders for a project.
 * Thin handlers; authz and logic live in `@/lib/projects/folder-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { createProjectFolder, listProjectFolders, projectRootAccess } from '@/lib/projects/folder-service'

type Params = { id: string }

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().nullable().optional(),
})

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const folders = await listProjectFolders(params.id, session)
    // What the reader may do at the project root (ADR-0079): the project's
    // document-write permission alone. Each folder carries its own `access`.
    return { folders, rootAccess: await projectRootAccess(session, params.id) }
  },
  { authz: { enforcedBy: 'listProjectFolders (requireProjectAccess project:view; folder read access)' } }
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
    authz: { enforcedBy: 'createProjectFolder (requireFolderWrite: project:documents:write + write on the parent)' },
  }
)
