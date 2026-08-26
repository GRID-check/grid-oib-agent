import type { FileItem, FolderItem } from './components/project-file-workspace'

/**
 * How many documents a folder holds, ITS SUBFOLDERS INCLUDED.
 *
 * The recursive count is the honest one for a tile a reader has not opened yet:
 * a "Pläne" folder whose nine files all sit in "Einreichung" is not empty, and a
 * tile saying `0 Dateien` over a folder full of plans would send them to the
 * tree view to find out what is really in there.
 *
 * No request is involved — the workspace already loads the project's whole
 * corpus in one `/api/documents` call (it has to: the listing filters, searches
 * and counts client-side), so these numbers are a fold over data in hand.
 *
 * A cycle in `parentId` (which the schema does not permit, but which a bad
 * response could still carry) is walked once and then stopped, rather than
 * hanging the browser.
 */
export function countDocumentsInFolder(
  files: readonly FileItem[],
  folders: readonly FolderItem[],
  folderId: string
): number {
  const childrenOf = new Map<string, string[]>()
  for (const folder of folders) {
    if (folder.parentId === null) continue
    const siblings = childrenOf.get(folder.parentId)
    if (siblings) siblings.push(folder.id)
    else childrenOf.set(folder.parentId, [folder.id])
  }

  const seen = new Set<string>([folderId])
  const stack = [folderId]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      stack.push(child)
    }
  }

  return files.reduce(
    (total, file) => (file.folderId !== null && seen.has(file.folderId) ? total + 1 : total),
    0
  )
}

/**
 * The chain from the root down to `folderId`, outermost first — what a
 * breadcrumb walks back up. An unknown id yields an empty trail rather than
 * throwing: a folder can be deleted in another tab while this one is inside it.
 */
export function folderTrail(folders: readonly FolderItem[], folderId: string | null): FolderItem[] {
  if (folderId === null) return []
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const trail: FolderItem[] = []
  const seen = new Set<string>()
  let cursor = byId.get(folderId)
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    trail.unshift(cursor)
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
  }
  return trail
}
