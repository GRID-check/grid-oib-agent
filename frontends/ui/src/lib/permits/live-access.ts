/**
 * Who may be served a permit record, judged from where its document is NOW.
 *
 * A record's stored restriction is a snapshot of the collection the document
 * sat in when it was read, and the collection only follows a folder change
 * once placement has run: a move or a new access list updates `folder_id`
 * first, placement may skip a document whose ingest is in flight, moves at
 * most a batch per call, and a failed purge leaves a document in place. In
 * that window the snapshot says "open" for a document that no longer is.
 * So the access is decided as the document hits beside it are decided
 * (`hiddenFolderIds` in `documents/service.ts`): from the document's live
 * `folder_id` against the project's folder tree, and the restriction the
 * hand-out records and the agent's admission reads is the live one too.
 */

import 'server-only'
import {
  folderTree,
  loadCustomFolderTree,
  readRestrictingFoldersOnPath,
  type AccessFolder,
  type FolderTree,
} from '@/lib/authz/folder-access'
import { canonicalRestriction } from '@/lib/projects/memory-service'

/** One project's folders as a reader may be served a permit from them. */
export interface LiveFolderAccess {
  /**
   * The folders whose documents' records this reader may be served; null when
   * the project has no restricted and no binned folder, so every folder is.
   * A folder not listed (one created since, a binned one, one restricted to
   * others) is not served: the safe direction.
   */
  visibleFolderIds: string[] | null
  /** The folders restricting a document filed in `folderId` now, canonical; null for an open one. */
  restrictionOf(folderId: string | null): string[] | null
}

const OPEN: LiveFolderAccess = { visibleFolderIds: null, restrictionOf: () => null }

function deletedOnPath(tree: FolderTree, folderId: string): boolean {
  const seen = new Set<string>()
  for (let current = tree.get(folderId); current && !seen.has(current.id); ) {
    if (current.deleted) return true
    seen.add(current.id)
    current = current.parentId ? tree.get(current.parentId) : undefined
  }
  return false
}

/**
 * The pure half: given the project's folder tree and the restricted folders
 * the reader is cleared for, which folders are served and what restricts each.
 * A folder is served when nothing on its path is in the Papierkorb and every
 * folder restricting it is one the reader is cleared for.
 */
export function liveFolderAccessOf(folders: readonly AccessFolder[] | null, readableFolderIds: readonly string[]): LiveFolderAccess {
  if (!folders) return OPEN
  const tree = folderTree(folders)
  const readable = new Set(readableFolderIds.map((id) => id.toLowerCase()))
  const visibleFolderIds = folders
    .filter((folder) => !deletedOnPath(tree, folder.id))
    .filter((folder) => readRestrictingFoldersOnPath(tree, folder.id).every((id) => readable.has(id.toLowerCase())))
    .map((folder) => folder.id)
  return {
    visibleFolderIds,
    restrictionOf: (folderId) => (folderId ? canonicalRestriction(readRestrictingFoldersOnPath(tree, folderId)) : null),
  }
}

/** {@link liveFolderAccessOf} for one project, its tree read now. */
export async function liveFolderAccess(
  organizationId: string,
  projectId: string,
  readableFolderIds: readonly string[]
): Promise<LiveFolderAccess> {
  return liveFolderAccessOf(await loadCustomFolderTree(organizationId, projectId), readableFolderIds)
}
