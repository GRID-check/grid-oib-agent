/**
 * Folder access client (ADR-0078): restrict a project folder to roles, or open
 * it again, through `PUT /api/projects/[id]/folders/[folderId]/access`.
 *
 * The server moves the folder's documents into the collection the change puts
 * them in before it answers; `moved` counts them and `failed` lists the ones
 * that could not move this time (saving again retries exactly those).
 */

import { z } from 'zod'
import { ApiRequestError } from './api-error'

const FolderAccessResultSchema = z.object({
  folderId: z.string(),
  roles: z.array(z.string()).nullable(),
  moved: z.number(),
  failed: z.array(z.string()),
})

export type FolderAccessResult = z.infer<typeof FolderAccessResultSchema>

/** `roles: null` (or empty) opens the folder to everyone in the project. */
export async function setFolderAccess(
  projectId: string,
  folderId: string,
  roles: string[] | null
): Promise<FolderAccessResult> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/access`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: roles && roles.length > 0 ? roles : null }),
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
