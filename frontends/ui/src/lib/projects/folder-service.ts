/**
 * A project's folders — the project half of the shelf-parameterised folder
 * core in `@/lib/documents/shelf-folders` (ADR-0078).
 *
 * Everything that makes a folder a folder lives there and is shared with the
 * org-wide Archiv, authorization included (`@/lib/documents/shelf-authz`:
 * `project:view` to read, `project:documents:write` or `project:edit` to
 * change). What is left here is the names and signatures a project's callers
 * know. The Archiv's twin is `@/lib/archiv/folder-service`.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { projectShelf } from '@/lib/documents/shelf'
import {
  createShelfFolder,
  deleteShelfFolder,
  ensureShelfFolderPaths,
  getOrCreateShelfRootFolder,
  listShelfFolders,
  mirrorShelfFolderPathRewrite,
  updateShelfFolder,
  type FolderRow,
} from '@/lib/documents/shelf-folders'

export { toFolderRow } from '@/lib/documents/shelf-folders'
export type { DeleteFolderResult, FolderRow } from '@/lib/documents/shelf-folders'

export interface CreateFolderInput {
  projectId: string
  parentId?: string | null
  name: string
}

export interface UpdateFolderInput {
  projectId: string
  folderId: string
  /** New name. Omitted leaves it alone. */
  name?: string
  /** New parent — `null` moves the folder to the project root. Omitted leaves it. */
  parentId?: string | null
}

export interface DeleteFolderInput {
  projectId: string
  folderId: string
}

export interface EnsureFolderPathsInput {
  projectId: string
  /** The level the paths are relative to. `null` is the project root. */
  parentId: string | null
  /** Relative folder paths, `Wohnbau Nord/03_Einreichung` style. */
  paths: readonly string[]
}

export function listProjectFolders(projectId: string, session: AuthorizedSession) {
  return listShelfFolders(session, projectShelf(projectId))
}

export function createProjectFolder(input: CreateFolderInput, session: AuthorizedSession) {
  return createShelfFolder(session, projectShelf(input.projectId), input)
}

/**
 * The project's root folder with this name, creating it on first use — see
 * {@link getOrCreateShelfRootFolder} for the race it is safe under.
 *
 * ## Why it takes no session
 *
 * Unlike every other function in this module it does NOT authorize. It is a
 * destination resolver for a caller that has already required
 * `project:documents:write` on this exact project, and adding a second check
 * here would say the authorization decision lives in two places. Do not call it
 * from a route. The organization is a parameter because the folder row carries
 * its tenant (migration 0102), which the caller has in hand.
 */
export function getOrCreateProjectFolderByName(
  projectId: string,
  name: string,
  organizationId: string,
): Promise<FolderRow> {
  return getOrCreateShelfRootFolder(projectShelf(projectId), organizationId, name)
}

export function ensureProjectFolderPaths(input: EnsureFolderPathsInput, session: AuthorizedSession) {
  return ensureShelfFolderPaths(session, projectShelf(input.projectId), input)
}

export function updateProjectFolder(input: UpdateFolderInput, session: AuthorizedSession) {
  return updateShelfFolder(session, projectShelf(input.projectId), input)
}

export function deleteProjectFolder(input: DeleteFolderInput, session: AuthorizedSession) {
  return deleteShelfFolder(session, projectShelf(input.projectId), input.folderId)
}

/** The path mirror onto a project's collection — see {@link mirrorShelfFolderPathRewrite}. */
export function mirrorFolderPathRewrite(
  projectId: string,
  organizationId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  return mirrorShelfFolderPathRewrite(projectShelf(projectId), organizationId, fromPath, toPath)
}
