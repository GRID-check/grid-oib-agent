/**
 * One project folder — rename, move, delete.
 *
 * Thin handlers; authz and logic live in `@/lib/projects/folder-service`. The
 * delete is the one worth reading before changing: `documents.folder_id` is
 * `ON DELETE CASCADE`, so the service re-files the folder's documents and its
 * child folders first, and then keeps the row as a tombstone (ADR-0079).
 * Deleting a label must not delete the work that was filed under it, nor the
 * access that decides who may read what was derived from it.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { deleteProjectFolder, updateProjectFolder } from '@/lib/projects/folder-service'

type Params = { id: string; folderId: string }

const updateFolderSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    // Explicit `null` moves the folder to the project root, which is why this
    // is `.nullable().optional()` and not merely optional: absent and null mean
    // different things here.
    parentId: z.string().uuid().nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.parentId !== undefined, {
    message: 'Nothing to update.',
  })

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, updateFolderSchema)
    const result = await updateProjectFolder(
      {
        projectId: params.id,
        folderId: params.folderId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
      },
      session,
      request
    )
    if (!result.ok) throw new BadRequestError(result.error)
    return { folder: result.folder }
  },
  {
    authz: {
      enforcedBy:
        'updateProjectFolder (requireFolderWrite: project:documents:write + write on the folder and the new parent; project:manage when the move changes an access list over the subtree)',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params, request }) => {
    const result = await deleteProjectFolder(
      { projectId: params.id, folderId: params.folderId },
      session,
      request
    )
    if (!result.ok) throw new BadRequestError(result.error)
    return result.result
  },
  {
    authz: {
      enforcedBy:
        'deleteProjectFolder (requireFolderWrite: project:documents:write + write on the folder and its child folders; project:manage for a folder with its own access list)',
    },
  }
)
