/**
 * What the document picker shows at a place, as pure functions: which folders
 * and documents, in what order, matching what search. The dialog holds the
 * state; this decides what it means, so every rule is testable without a DOM.
 */

import type { FileItem, FolderItem } from '@/features/documents/components/project-file-workspace'

/** The shelves a picker can list, in the knowledge layer's words (ADR-0047). */
export type PickerShelf = 'project' | 'archiv' | 'session' | 'base'

/**
 * One document the picker can offer. The name is its identity — what a
 * caller is handed back and what a run is told. The file, when the listing
 * supplied one, carries what the list's columns and the preview show.
 */
export interface PickerDocument {
  name: string
  title?: string
  shelf?: string
  file?: Pick<FileItem, 'folderId' | 'fileSize' | 'createdAt' | 'contentType' | 'pageCount' | 'summary' | 'tags'>
}

/** Where the panel is looking. */
export type PickerPlace =
  | { kind: 'recent' }
  | { kind: 'selected' }
  | { kind: 'shelf'; shelf: PickerShelf; folderId: string | null }

export type PickerSortKey = 'name' | 'date' | 'size'
export interface PickerSort {
  key: PickerSortKey
  direction: 'asc' | 'desc'
}

/** The shelves in the order the sidebar lists them. */
export const PICKER_SHELVES: readonly PickerShelf[] = ['project', 'archiv', 'session', 'base']

/** Documents shown under „Zuletzt". */
export const RECENT_LIMIT = 12

export const fold = (value: string): string => value.trim().toLocaleLowerCase()

export const pickerLabel = (doc: PickerDocument): string => doc.title?.trim() || doc.name

export const shelfOf = (doc: PickerDocument): PickerShelf =>
  doc.shelf === 'archiv' || doc.shelf === 'session' || doc.shelf === 'base' ? doc.shelf : 'project'

export const samePlace = (a: PickerPlace, b: PickerPlace): boolean =>
  a.kind === b.kind && (a.kind !== 'shelf' || (b.kind === 'shelf' && a.shelf === b.shelf && a.folderId === b.folderId))

const time = (doc: PickerDocument): number => {
  const at = doc.file?.createdAt ? Date.parse(doc.file.createdAt) : NaN
  return Number.isNaN(at) ? 0 : at
}

export function sortDocuments(docs: readonly PickerDocument[], sort: PickerSort, locale: string): PickerDocument[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const byName = (a: PickerDocument, b: PickerDocument) =>
    pickerLabel(a).localeCompare(pickerLabel(b), locale, { numeric: true, sensitivity: 'base' })
  return [...docs].sort((a, b) => {
    const primary =
      sort.key === 'date'
        ? time(a) - time(b)
        : sort.key === 'size'
          ? (a.file?.fileSize ?? 0) - (b.file?.fileSize ?? 0)
          : byName(a, b)
    return primary !== 0 ? sign * primary : byName(a, b)
  })
}

/** Every folder beneath `folderId`, itself included, for a search that reaches down. */
function subtree(folderId: string, folders: readonly FolderItem[]): Set<string> {
  const ids = new Set([folderId])
  let grew = true
  while (grew) {
    grew = false
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        grew = true
      }
    }
  }
  return ids
}

/** The folders a project folder listing knows, so a document in an unknown one is shown at the root. */
const knownFolder = (doc: PickerDocument, folders: readonly FolderItem[]): string | null => {
  const id = doc.file?.folderId ?? null
  return id && folders.some((folder) => folder.id === id) ? id : null
}

export interface PlaceContents {
  folders: FolderItem[]
  documents: PickerDocument[]
}

/**
 * What a place shows. A search looks through the place and everything beneath
 * it, flat, as an open panel's search does; without one, a folder shows its
 * own subfolders and documents.
 */
export function contentsAt(
  place: PickerPlace,
  input: {
    documents: readonly PickerDocument[]
    folders: readonly FolderItem[]
    selected: ReadonlySet<string>
    query: string
    sort: PickerSort
    locale: string
  }
): PlaceContents {
  const { documents, folders, selected, sort, locale } = input
  const needle = fold(input.query)
  const matches = (doc: PickerDocument) =>
    !needle || fold(pickerLabel(doc)).includes(needle) || fold(doc.name).includes(needle)

  if (place.kind === 'recent') {
    const recent = [...documents].sort((a, b) => time(b) - time(a)).slice(0, RECENT_LIMIT)
    return { folders: [], documents: needle ? sortDocuments(recent.filter(matches), sort, locale) : recent }
  }
  if (place.kind === 'selected') {
    return { folders: [], documents: sortDocuments(documents.filter((doc) => selected.has(fold(doc.name)) && matches(doc)), sort, locale) }
  }

  const onShelf = documents.filter((doc) => shelfOf(doc) === place.shelf)
  const shelfFolders = place.shelf === 'project' ? folders : []
  if (needle) {
    const scope = place.folderId ? subtree(place.folderId, shelfFolders) : null
    const inScope = (doc: PickerDocument) => !scope || scope.has(knownFolder(doc, shelfFolders) ?? '')
    return { folders: [], documents: sortDocuments(onShelf.filter((doc) => inScope(doc) && matches(doc)), sort, locale) }
  }
  return {
    folders: shelfFolders
      .filter((folder) => (folder.parentId ?? null) === place.folderId)
      .sort((a, b) => a.name.localeCompare(b.name, locale, { numeric: true, sensitivity: 'base' })),
    documents: sortDocuments(
      onShelf.filter((doc) => knownFolder(doc, shelfFolders) === place.folderId),
      sort,
      locale
    ),
  }
}

/** The folders from the shelf's root down to `folderId`. */
export function folderTrail(folderId: string | null, folders: readonly FolderItem[]): FolderItem[] {
  const trail: FolderItem[] = []
  let id = folderId
  while (id) {
    const folder = folders.find((candidate) => candidate.id === id)
    if (!folder || trail.includes(folder)) break
    trail.unshift(folder)
    id = folder.parentId ?? null
  }
  return trail
}

/** How many documents a folder holds, its subfolders included. */
export function folderCount(folderId: string, documents: readonly PickerDocument[], folders: readonly FolderItem[]): number {
  const ids = subtree(folderId, folders)
  return documents.filter((doc) => ids.has(knownFolder(doc, folders) ?? '')).length
}
