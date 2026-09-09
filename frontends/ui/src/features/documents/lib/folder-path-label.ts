/**
 * A folder's full path, for a flat list of destinations.
 *
 * The submenu is deliberately flat rather than a nested cascade: picking a
 * destination is one decision, and making the reader walk the tree to reach a
 * folder they can already name turns it into several. `Brandschutz / Fluchtwege`
 * says where it is without asking them to travel there.
 */

export interface PathFolder {
  id: string
  name: string
  parentId: string | null
}

export function folderPathLabel(folder: PathFolder, byId: Map<string, PathFolder>): string {
  const parts = [folder.name]
  let parentId = folder.parentId
  // Bounded by the map size: a cycle cannot outlast the folders that exist.
  for (let hops = 0; parentId && hops < byId.size; hops += 1) {
    const parent = byId.get(parentId)
    if (!parent) break
    parts.unshift(parent.name)
    parentId = parent.parentId
  }
  return parts.join(' / ')
}

export function sortedFolderDestinations(
  folders: readonly PathFolder[],
): { folder: PathFolder; label: string }[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  return folders
    .map((folder) => ({ folder, label: folderPathLabel(folder, byId) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
