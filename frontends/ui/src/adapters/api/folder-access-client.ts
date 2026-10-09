/**
 * Folder access client (ADR-0088): who may read and who may write a project
 * folder, through `PUT /api/projects/[id]/folders/[folderId]/access`.
 *
 * A folder inherits its parent's access, or has its own list of roles, each
 * with `read` or `write`; `*` is every member of the project. The server moves
 * the folder's documents into the collection a change of READ access puts them
 * in before it answers; `moved` counts them and `failed` lists the ones that
 * could not move this time (saving again retries exactly those).
 */

import { z } from 'zod'
import { ApiRequestError } from './api-error'

/** The role slug of a grant to every member of the project. */
export const EVERY_PROJECT_MEMBER = '*'

const FolderGrantSchema = z.object({
  role: z.string(),
  level: z.enum(['read', 'write']),
})

/** One entry of a folder's own access list. */
export type FolderGrantItem = z.infer<typeof FolderGrantSchema>

/** A folder's access, as it is set. */
export type FolderAccessSetting = { mode: 'inherit' } | { mode: 'custom'; grants: FolderGrantItem[] }

const FolderAccessResultSchema = z.object({
  folderId: z.string(),
  access: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('inherit') }),
    z.object({ mode: z.literal('custom'), grants: z.array(FolderGrantSchema) }),
  ]),
  moved: z.number(),
  failed: z.array(z.string()),
})

export type FolderAccessResult = z.infer<typeof FolderAccessResultSchema>

export async function setFolderAccess(
  projectId: string,
  folderId: string,
  access: FolderAccessSetting
): Promise<FolderAccessResult> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/access`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(access),
    }
  )
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message
    throw new ApiRequestError(
      typeof message === 'string' && message ? message : `Failed to change folder access: ${response.status}`,
      response.status
    )
  }
  return FolderAccessResultSchema.parse(await response.json())
}
