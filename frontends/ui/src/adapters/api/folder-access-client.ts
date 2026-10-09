/**
 * Folder access client (ADR-0088, ADR-0096): who may read and who may write a
 * project folder, through `GET`/`PUT /api/projects/[id]/folders/[folderId]/access`.
 *
 * A folder inherits its parent's access, or has its own list: people, each with
 * `read` or `write`, and optionally everyone in the project reading it. The
 * people hold a folder role on the folder in WorkOS. The server moves the
 * folder's documents into the collection a change of READ access puts them in
 * before it answers; `moved` counts them and `failed` lists the ones that could
 * not move this time (saving again retries exactly those).
 *
 * The people a list may name are the project's members, read from
 * `GET /api/projects/[id]/members` (`listProjectPeople`).
 */

import { z } from 'zod'
import { ApiRequestError } from './api-error'

const FolderPersonSchema = z.object({
  userId: z.string(),
  level: z.enum(['read', 'write']),
})

/** One person on a folder's own access list. */
export type FolderPersonItem = z.infer<typeof FolderPersonSchema>

const FolderAccessSettingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }),
  z.object({ mode: z.literal('custom'), everyoneReads: z.boolean(), people: z.array(FolderPersonSchema) }),
])

/** A folder's access, as it is set. */
export type FolderAccessSetting = z.infer<typeof FolderAccessSettingSchema>

const FolderAccessResultSchema = z.object({
  folderId: z.string(),
  access: FolderAccessSettingSchema,
  moved: z.number(),
  failed: z.array(z.string()),
})

export type FolderAccessResult = z.infer<typeof FolderAccessResultSchema>

const accessUrl = (projectId: string, folderId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/access`

async function failure(response: Response, fallback: string): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null)
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  return new ApiRequestError(typeof message === 'string' && message ? message : `${fallback}: ${response.status}`, response.status)
}

/** The folder's access as it is now, with the people on its list. */
export async function getFolderAccess(projectId: string, folderId: string): Promise<FolderAccessSetting> {
  const response = await fetch(accessUrl(projectId, folderId))
  if (!response.ok) throw await failure(response, 'Failed to load folder access')
  return FolderAccessSettingSchema.parse(await response.json())
}

export async function setFolderAccess(
  projectId: string,
  folderId: string,
  access: FolderAccessSetting
): Promise<FolderAccessResult> {
  const response = await fetch(accessUrl(projectId, folderId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(access),
  })
  if (!response.ok) throw await failure(response, 'Failed to change folder access')
  return FolderAccessResultSchema.parse(await response.json())
}

const ProjectMembersSchema = z.object({
  members: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      role: z.string().nullable(),
    })
  ),
})

/** Someone a folder's own list may name: a member of the project. */
export interface ProjectPerson {
  userId: string
  name: string
  email: string | null
}

/**
 * The project's members, the people a folder's own list may name. The route
 * lists the whole organization; a member without a project role (`role: null`)
 * is left out, because the project gives them nothing to narrow. Needs
 * `project:members:manage` or `project:manage`, which whoever may change a
 * folder's list holds.
 */
export async function listProjectPeople(projectId: string): Promise<ProjectPerson[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`)
  if (!response.ok) throw await failure(response, 'Failed to load the project members')
  return ProjectMembersSchema.parse(await response.json())
    .members.filter((member) => member.role !== null)
    .map(({ userId, name, email }) => ({ userId, name, email }))
}
