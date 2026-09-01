/**
 * The folder a reader is standing in, as a URL rather than as state.
 *
 * Drilling into a folder used to be `useState`, which made the browser's back
 * button a way OUT of Dateien rather than a way back up one level: it left the
 * page entirely and discarded the level, the view and the scroll position. It
 * also meant no folder could be linked, bookmarked or reloaded — the corpus had
 * exactly one address however deep you were in it.
 *
 * So the level is a route segment now: `/app/projects/<id>/files/Pläne/EG`.
 * Names, not ids, because the URL is something a person reads and sends, and
 * because the pieces that make names safe here are already enforced by the
 * server: `validateFolderName` strips `/` and `\` out of every name, and
 * `uniq_project_folders_parent_name` (migration 0063) makes a sibling name
 * unique — so a path names exactly one folder, and the `path` column each
 * folder already carries IS the address.
 *
 * The cost of names over ids is that a rename moves the address. That is
 * handled where it happens (the workspace follows the folder it believes it is
 * in), and it is the same trade `?model=<filename>` already makes one route up.
 */

import { pathSegments } from '@/lib/projects/folders'

/** The part of a folder this module needs: its id and its materialised path. */
export interface FolderPathLike {
  id: string
  path: string
}

/**
 * The canonical comparison key for a folder path.
 *
 * Both sides go through the server's own normalisation, so a stored `/Pläne/EG`
 * and a URL `Pläne/EG` are the same folder — the leading slash, a doubled
 * separator or a trailing one cannot make a folder unreachable.
 */
export function folderPathKey(path: string | null | undefined): string {
  return pathSegments(path).join('/')
}

/** The URL segments for a folder path, ready to be joined into an href. */
export function folderPathToSegments(path: string | null | undefined): string[] {
  return pathSegments(path)
}

/** The folder a URL path names, or `null` for the corpus root / no such folder. */
export function findFolderByPath<T extends FolderPathLike>(
  folders: readonly T[],
  path: string | readonly string[] | null | undefined
): T | null {
  const raw = typeof path === 'string' ? path : path ? path.join('/') : ''
  const key = folderPathKey(raw)
  if (!key) return null
  return folders.find((folder) => folderPathKey(folder.path) === key) ?? null
}

/** The Dateien route for a project, at the corpus root. */
export function filesRootHref(projectId: string): string {
  return `/app/projects/${encodeURIComponent(projectId)}/files`
}

/**
 * The address of one folder — the root href when the path is empty.
 *
 * Each segment is encoded on its own: a name may hold anything except a
 * separator, and `encodeURIComponent` over the whole path would eat the `/`
 * that makes it a path.
 */
export function folderHref(projectId: string, path: string | null | undefined): string {
  const segments = pathSegments(path)
  if (segments.length === 0) return filesRootHref(projectId)
  return `${filesRootHref(projectId)}/${segments.map(encodeURIComponent).join('/')}`
}
