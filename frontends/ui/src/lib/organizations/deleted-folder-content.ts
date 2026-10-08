/**
 * Organisation → Sensible Daten → „Inhalte aus gelöschten Ordnern" (ADR-0087):
 * who sees chats, answers and notes drawn from a folder once its purge has
 * run. The read half; the write is `./deleted-folder-content-service.ts`.
 *
 * Stored in `organizations.settings.deletedFolderContent`. Read at READ time by
 * the folder tree loader (`listProjectFolderTree`), so the one rule,
 * `effectiveFolderLevel`, applies it to every derived item at once and a change
 * takes effect without a rewrite. Kept light (the organization row and the
 * cache, nothing of the settings service) because the access decision imports
 * it.
 */

import 'server-only'
import { z } from 'zod'
import { getCached, invalidateCached } from '@/lib/cache'
import {
  DELETED_FOLDER_CONTENT_POLICIES,
  type DeletedFolderContentPolicy,
} from '@/lib/authz/folder-access-rule'
import { findOrganization } from './repository'

/** The key in `organizations.settings`. */
export const DELETED_FOLDER_CONTENT_SETTING = 'deletedFolderContent'

/** The default: the same people who could read the folder keep seeing what was drawn from it. */
export const DEFAULT_DELETED_FOLDER_CONTENT: DeletedFolderContentPolicy = 'unchanged'

export const deletedFolderContentSchema = z.object({
  policy: z.enum(DELETED_FOLDER_CONTENT_POLICIES),
})

const CACHE_TTL_MS = 30_000
const cacheKey = (organizationId: string): string => `deleted-folder-content:${organizationId}`

/** A stored value read back: anything that is not one of the four choices is the default. */
export function resolveDeletedFolderContentPolicy(stored: unknown): DeletedFolderContentPolicy {
  const parsed = z.enum(DELETED_FOLDER_CONTENT_POLICIES).safeParse(stored)
  return parsed.success ? parsed.data : DEFAULT_DELETED_FOLDER_CONTENT
}

/** The organization's choice, at most 30 seconds old. */
export async function getDeletedFolderContentPolicy(organizationId: string): Promise<DeletedFolderContentPolicy> {
  return getCached(cacheKey(organizationId), CACHE_TTL_MS, async () => {
    const row = await findOrganization(organizationId)
    const settings = (row?.settings ?? {}) as Record<string, unknown>
    return resolveDeletedFolderContentPolicy(settings[DELETED_FOLDER_CONTENT_SETTING])
  })
}

/** Forget the cached choice after a save. */
export async function invalidateDeletedFolderContentPolicy(organizationId: string): Promise<void> {
  await invalidateCached(cacheKey(organizationId))
}
