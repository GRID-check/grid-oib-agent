/**
 * The org-wide Archiv's folders — the Archiv half of the shelf-parameterised
 * folder core in `@/lib/documents/shelf-folders` (ADR-0078).
 *
 * The twin of `@/lib/projects/folder-service`, and the same code underneath,
 * authorization included (`@/lib/documents/shelf-authz`): any member of the
 * organization may read the tree, as they may read the Archiv itself; changing
 * it takes `org:archiv:manage` (`canManageArchiv`), the permission that already
 * gates uploading and deleting there — a folder is a label on those documents,
 * so it is gated like them.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { ARCHIV_SHELF } from '@/lib/documents/shelf'
import {
  createShelfFolder,
  deleteShelfFolder,
  ensureShelfFolderPaths,
  listShelfFolders,
  updateShelfFolder,
} from '@/lib/documents/shelf-folders'

export function listArchivFolders(session: AuthorizedSession) {
  return listShelfFolders(session, ARCHIV_SHELF)
}

export function createArchivFolder(
  session: AuthorizedSession,
  input: { parentId?: string | null; name: string },
) {
  return createShelfFolder(session, ARCHIV_SHELF, input)
}

export function updateArchivFolder(
  session: AuthorizedSession,
  input: { folderId: string; name?: string; parentId?: string | null },
) {
  return updateShelfFolder(session, ARCHIV_SHELF, input)
}

export function deleteArchivFolder(session: AuthorizedSession, folderId: string) {
  return deleteShelfFolder(session, ARCHIV_SHELF, folderId)
}

export function ensureArchivFolderPaths(
  session: AuthorizedSession,
  input: { parentId: string | null; paths: readonly string[] },
) {
  return ensureShelfFolderPaths(session, ARCHIV_SHELF, input)
}
