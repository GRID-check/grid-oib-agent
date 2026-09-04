/**
 * Resolve a folder upload's directory paths to folder ids, creating what is
 * missing. Thin handler; the matching and the get-or-create races live in
 * `@/lib/projects/folder-service`.
 *
 * ## Why this is not the create endpoint with a loop in front of it
 *
 * `POST .../folders` creates ONE folder under ONE parent and refuses a name a
 * sibling already has — which is right for a person typing into the New-folder
 * popover, and wrong for a folder upload, where "it already exists" is the
 * common case and the desired outcome. Driving a 40-directory tree through it
 * from the browser would also be 40 sequential round trips before the first
 * byte of the first file moved, each one a chance for the tree to end up half
 * built.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { ensureProjectFolderPaths } from '@/lib/projects/folder-service'

type Params = { id: string }

const ensureFoldersSchema = z.object({
  /**
   * The level the paths are relative to — the folder the reader was standing in
   * when they dropped the tree. `null` is the project root.
   */
  parentId: z.string().uuid().nullable().optional(),
  /**
   * Distinct directory paths out of the dropped tree.
   *
   * Bounded here as well as in the service: this is the untrusted edge, and the
   * service's own ceiling exists for a caller that is not a route. 4096
   * characters per path is four times the `project_folders.path` column, which
   * is the real limit a segment walk runs into.
   */
  paths: z.array(z.string().min(1).max(4096)).max(300),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { parentId, paths } = await parseJsonBody(request, ensureFoldersSchema)
    const result = await ensureProjectFolderPaths(
      { projectId: params.id, parentId: parentId ?? null, paths },
      session,
    )
    if (!result.ok) throw new BadRequestError(result.error)
    return { folders: result.folders, folderIdByPath: result.folderIdByPath }
  },
  {
    authz: {
      enforcedBy: 'ensureProjectFolderPaths (requireProjectAccess project:documents:write)',
    },
  },
)
