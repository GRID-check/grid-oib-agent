/**
 * What Piloti knows about a folder — the whole subtree under it, not one level.
 *
 * ## Why this exists
 *
 * The listing has always carried what the ingest pipeline learned about each
 * document: whether it is readable, a one-sentence summary, the pages read,
 * what kinds of content it holds and the type and discipline tags. All of it
 * was spent one file at a time — a badge on a card, a paragraph in the preview
 * rail — so the only way to learn what Piloti had made of a project was to open
 * every folder and every file in it.
 *
 * feld72 said it in the first Jour fixe (2026-10-09): the read state of nested
 * subfolders is not visible at a glance, answers reported documents as missing
 * that had been read, and checking folder by folder does not scale. This module
 * is the answer to that sentence: one pass over the corpus the browser already
 * holds, folded up the folder tree, so a folder can say what is in it, how much
 * of it Piloti can cite, and what needs a person.
 *
 * Pure and outside React for the reason `file-filters.ts` is: this is logic,
 * and logic in a render function can only be tested by mounting a tree.
 */

import { documentStatusFacts } from '@/lib/documents/document-status'
import { DISCIPLINE_TAGS, DOCUMENT_TYPE_TAGS, documentTypeOf } from '@/lib/documents/tag-vocabulary'
import type { FileItem, FolderItem } from '../file-types'

/**
 * Where a document stands with Piloti, in the five answers a reader acts on.
 *
 * - `readable`  — indexed; Piloti can find and cite it.
 * - `reading`   — in flight; it will change on its own.
 * - `failed`    — the read went wrong; a person can retry it.
 * - `held`      — the content screen stopped it (ADR-0086); a person decides.
 * - `unindexed` — at rest and deliberately not in the knowledge base (an
 *                 agent-authored report, a row stranded at birth).
 *
 * Derived from {@link documentStatusFacts} and from nothing else, so the five
 * spellings of "indexed" stay one decision with one home.
 */
export type ReadState = 'readable' | 'reading' | 'failed' | 'held' | 'unindexed'

/**
 * An unknown status reads as `reading`, never as `readable`: calling something
 * citable that is not is the error that wastes an afternoon, and a new pipeline
 * state under "being read" until somebody maps it is the harmless direction.
 */
export function readStateOf(status: string | null | undefined): ReadState {
  switch (documentStatusFacts(status)?.variant) {
    case 'success':
      return 'readable'
    case 'destructive':
      return 'failed'
    case 'warning':
      return 'held'
    case 'secondary':
      return 'unindexed'
    default:
      return 'reading'
  }
}

/**
 * Whether Piloti placed a READABLE document in a document type. A document that
 * is not readable yet has nothing to place, so it is not counted here — it is
 * already counted under its read state.
 */
export function isUnplaced(file: Pick<FileItem, 'status' | 'tags'>): boolean {
  return readStateOf(file.status) === 'readable' && documentTypeOf(file.tags) === undefined
}

export interface KnowledgeTally {
  total: number
  readable: number
  reading: number
  failed: number
  held: number
  unindexed: number
  /** Readable, but in no document type. */
  unplaced: number
  /** Pages Piloti read, over the readable documents that report a count. */
  pages: number
  /** Newest `createdAt` in the set, or null for an empty one. */
  latest: string | null
}

export function emptyTally(): KnowledgeTally {
  return { total: 0, readable: 0, reading: 0, failed: 0, held: 0, unindexed: 0, unplaced: 0, pages: 0, latest: null }
}

function addFile(tally: KnowledgeTally, file: FileItem): void {
  const state = readStateOf(file.status)
  tally.total += 1
  tally[state] += 1
  if (state === 'readable') {
    if (documentTypeOf(file.tags) === undefined) tally.unplaced += 1
    if (typeof file.pageCount === 'number' && file.pageCount > 0) tally.pages += file.pageCount
  }
  if (file.createdAt && (tally.latest === null || file.createdAt > tally.latest)) tally.latest = file.createdAt
}

function addTally(into: KnowledgeTally, from: KnowledgeTally): void {
  into.total += from.total
  into.readable += from.readable
  into.reading += from.reading
  into.failed += from.failed
  into.held += from.held
  into.unindexed += from.unindexed
  into.unplaced += from.unplaced
  into.pages += from.pages
  if (from.latest && (into.latest === null || from.latest > into.latest)) into.latest = from.latest
}

export function tallyOf(files: readonly FileItem[]): KnowledgeTally {
  const tally = emptyTally()
  for (const file of files) addFile(tally, file)
  return tally
}

/**
 * The share of the documents Piloti is meant to read that it can read now.
 * `unindexed` is out of the denominator on purpose: a report Piloti wrote and
 * filed is not a document it failed to read. Null when there is nothing to read.
 */
export function readShare(tally: KnowledgeTally): number | null {
  const meantToRead = tally.total - tally.unindexed
  return meantToRead > 0 ? tally.readable / meantToRead : null
}

/**
 * The tally of every folder's WHOLE subtree, keyed by folder id.
 *
 * One post-order walk: documents bucketed by folder, folders by parent, and each
 * parent folded from what its children already computed — linear in the corpus.
 * Iterative and visit-marked rather than recursive, because `parentId` comes off
 * the wire and a cycle in it would otherwise overflow the stack in a render.
 */
export function subtreeTallies(
  files: readonly FileItem[],
  folders: readonly FolderItem[]
): Map<string, KnowledgeTally> {
  const direct = new Map<string, KnowledgeTally>()
  for (const file of files) {
    if (file.folderId == null) continue
    let tally = direct.get(file.folderId)
    if (!tally) direct.set(file.folderId, (tally = emptyTally()))
    addFile(tally, file)
  }

  const childrenByParent = childrenIndex(folders)
  const result = new Map<string, KnowledgeTally>()
  const visited = new Set<string>()
  for (const root of folders) {
    if (visited.has(root.id)) continue
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: root.id, expanded: false }]
    while (stack.length > 0) {
      const frame = stack.pop()!
      if (!frame.expanded) {
        if (visited.has(frame.id)) continue
        visited.add(frame.id)
        stack.push({ id: frame.id, expanded: true })
        for (const child of childrenByParent.get(frame.id) ?? []) {
          if (!visited.has(child.id)) stack.push({ id: child.id, expanded: false })
        }
        continue
      }
      const tally = emptyTally()
      const own = direct.get(frame.id)
      if (own) addTally(tally, own)
      for (const child of childrenByParent.get(frame.id) ?? []) {
        const nested = result.get(child.id)
        if (nested) addTally(tally, nested)
      }
      result.set(frame.id, tally)
    }
  }
  return result
}

function childrenIndex(folders: readonly FolderItem[]): Map<string, FolderItem[]> {
  const index = new Map<string, FolderItem[]>()
  for (const folder of folders) {
    if (folder.parentId === null) continue
    const bucket = index.get(folder.parentId)
    if (bucket) bucket.push(folder)
    else index.set(folder.parentId, [folder])
  }
  return index
}

/**
 * The ids of a folder and every folder beneath it. Null — the shelf root —
 * answers null, meaning "everything": a document whose folder is not in the
 * listing (a folder the reader may not open, a folder load that failed) still
 * belongs to the shelf.
 */
export function subtreeFolderIds(folders: readonly FolderItem[], rootId: string | null): Set<string> | null {
  if (rootId === null) return null
  const childrenByParent = childrenIndex(folders)
  const ids = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const child of childrenByParent.get(id) ?? []) {
      if (ids.has(child.id)) continue
      ids.add(child.id)
      stack.push(child.id)
    }
  }
  return ids
}

/** The documents anywhere under `folderId` — the whole shelf for null. */
export function filesInSubtree<T extends FileItem>(
  files: readonly T[],
  folders: readonly FolderItem[],
  folderId: string | null
): readonly T[] {
  const ids = subtreeFolderIds(folders, folderId)
  if (ids === null) return files
  return files.filter((file) => file.folderId != null && ids.has(file.folderId))
}

export interface CountedLabel {
  /** As the vocabulary spells it — and what the tag filter matches, lower-cased. */
  label: string
  count: number
}

export interface FolderLocation {
  folder: FolderItem
  /** Ancestor names from the brief's folder down, for "03_Einreichung / Pläne". */
  trail: string[]
  tally: KnowledgeTally
}

export interface FolderBrief {
  /** The whole subtree's tally. */
  tally: KnowledgeTally
  /** Every document in the subtree, in listing order. */
  files: readonly FileItem[]
  /** Document types present among READABLE documents, most frequent first. */
  documentTypes: CountedLabel[]
  /** OIB disciplines present among readable documents, most frequent first. */
  disciplines: CountedLabel[]
  /** Content categories (`text`, `table`, `image`, `chart`, …) and how many documents hold each. */
  contents: CountedLabel[]
  /** Documents that need a person, by why. */
  attention: {
    failed: FileItem[]
    held: FileItem[]
    unplaced: FileItem[]
  }
  /** Documents still being read. */
  reading: FileItem[]
  /**
   * Folders below this one whose OWN documents need attention or are still
   * being read — the deepest place the trouble is, so the reader is taken to
   * it rather than to its ancestor. Worst first, at most {@link MAX_HOTSPOTS}.
   */
  hotspots: FolderLocation[]
}

export const MAX_HOTSPOTS = 4

/** The catch-all type: true, and says nothing about the folder, so it never leads. */
const CATCH_ALL_TYPE = 'Sonstiges'

/**
 * Most frequent first; ties in the vocabulary's own order, so the list is
 * stable. „Sonstiges" goes last whatever its count — seven documents of type
 * "other" at the head of "what it is about" answers nothing.
 */
function countLabels(counts: Map<string, number>, order: readonly string[]): CountedLabel[] {
  const rank = (label: string) => {
    const index = order.indexOf(label)
    return index === -1 ? order.length : index
  }
  const last = (label: string) => (label === CATCH_ALL_TYPE ? 1 : 0)
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort(
      (a, b) =>
        last(a.label) - last(b.label) ||
        b.count - a.count ||
        rank(a.label) - rank(b.label) ||
        a.label.localeCompare(b.label)
    )
}

const CONTENT_ORDER = ['text', 'table', 'image', 'chart', 'drawing']

/**
 * A failure outranks a hold outranks a read in progress outranks an unplaced
 * document; within a class, more is worse. Compared class by class — a weighted
 * sum would let a hundred documents being read outrank one held back.
 */
function compareSeverity(a: KnowledgeTally, b: KnowledgeTally): number {
  return b.failed - a.failed || b.held - a.held || b.reading - a.reading || b.unplaced - a.unplaced
}

/**
 * Everything the folder brief says about `folderId` (null: the shelf root).
 *
 * Content is only ever read from READABLE documents: a quarantined file's tags
 * describe content the office has not released, and a failed one's are absent
 * or stale. Their existence is counted; what they say is not.
 */
export function buildFolderBrief(
  files: readonly FileItem[],
  folders: readonly FolderItem[],
  folderId: string | null
): FolderBrief {
  const subtree = filesInSubtree(files, folders, folderId)
  const tally = tallyOf(subtree)

  const types = new Map<string, number>()
  const disciplines = new Map<string, number>()
  const contents = new Map<string, number>()
  const attention: FolderBrief['attention'] = { failed: [], held: [], unplaced: [] }
  const reading: FileItem[] = []
  const typeSet = new Set<string>(DOCUMENT_TYPE_TAGS)
  const disciplineSet = new Set<string>(DISCIPLINE_TAGS)

  for (const file of subtree) {
    const state = readStateOf(file.status)
    if (state === 'failed') attention.failed.push(file)
    else if (state === 'held') attention.held.push(file)
    else if (state === 'reading') reading.push(file)
    if (state !== 'readable') continue
    if (documentTypeOf(file.tags) === undefined) attention.unplaced.push(file)
    // A document listing a tag twice is still one document of that type.
    for (const tag of new Set(file.tags ?? [])) {
      if (typeSet.has(tag)) types.set(tag, (types.get(tag) ?? 0) + 1)
      else if (disciplineSet.has(tag)) disciplines.set(tag, (disciplines.get(tag) ?? 0) + 1)
    }
    for (const content of new Set(file.contentTypes ?? [])) {
      contents.set(content, (contents.get(content) ?? 0) + 1)
    }
  }

  return {
    tally,
    files: subtree,
    documentTypes: countLabels(types, DOCUMENT_TYPE_TAGS),
    disciplines: countLabels(disciplines, DISCIPLINE_TAGS),
    contents: countLabels(contents, CONTENT_ORDER),
    attention,
    reading,
    hotspots: findHotspots(files, folders, folderId),
  }
}

/**
 * Folders strictly below `folderId` whose own documents need a person or are
 * being read. "Own" so that one broken file deep in a tree names its folder
 * once, instead of naming every ancestor between it and the brief.
 */
function findHotspots(
  files: readonly FileItem[],
  folders: readonly FolderItem[],
  folderId: string | null
): FolderLocation[] {
  const below = subtreeFolderIds(folders, folderId)
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const direct = new Map<string, FileItem[]>()
  for (const file of files) {
    if (file.folderId == null || file.folderId === folderId) continue
    if (!byId.has(file.folderId)) continue
    if (below !== null && !below.has(file.folderId)) continue
    const bucket = direct.get(file.folderId)
    if (bucket) bucket.push(file)
    else direct.set(file.folderId, [file])
  }

  const spots: FolderLocation[] = []
  for (const [id, own] of direct) {
    const tally = tallyOf(own)
    if (tally.failed + tally.held + tally.reading + tally.unplaced === 0) continue
    const folder = byId.get(id)!
    spots.push({ folder, trail: trailBetween(byId, folder, folderId), tally })
  }
  return spots
    .sort((a, b) => compareSeverity(a.tally, b.tally) || a.folder.name.localeCompare(b.folder.name))
    .slice(0, MAX_HOTSPOTS)
}

/** Folder names from just below `stopAt` down to `folder`, cycle-safe. */
function trailBetween(byId: Map<string, FolderItem>, folder: FolderItem, stopAt: string | null): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  let current: FolderItem | undefined = folder
  while (current && current.id !== stopAt && !seen.has(current.id)) {
    seen.add(current.id)
    names.unshift(current.name)
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return names
}

/**
 * A slice of a folder's subtree the brief can show as a flat listing: the
 * documents in one read state, carrying one tag, or readable but unplaced.
 */
export type BriefSelection =
  | { kind: 'state'; state: ReadState }
  | { kind: 'tag'; tag: string }
  | { kind: 'unplaced' }

export function matchesBriefSelection(file: FileItem, selection: BriefSelection): boolean {
  switch (selection.kind) {
    case 'state':
      return readStateOf(file.status) === selection.state
    case 'tag':
      // Tags are only ever counted on readable documents, so the slice a tag
      // chip opens has to be the same set the chip counted.
      return readStateOf(file.status) === 'readable' && (file.tags ?? []).includes(selection.tag)
    case 'unplaced':
      return isUnplaced(file)
  }
}

/** The one thing a folder line names about its documents: the worst state in it. */
export interface ReadMark {
  state: 'failed' | 'held' | 'reading' | 'unplaced' | 'allRead'
  count: number
}

/**
 * Failure outranks a hold outranks a read in progress; an unplaced document is
 * named only where the caller asks for it (the brief's hotspots do, a folder
 * tile does not — on a tile it would be noise on half the folders of a project).
 * When nothing is wrong and everything Piloti is meant to read is read, the
 * mark says so: "alles gelesen" is the answer feld72 was opening folders for.
 * Null for an empty folder, or one holding only documents Piloti never reads.
 */
export function readMarkOf(tally: KnowledgeTally, { withUnplaced = false } = {}): ReadMark | null {
  if (tally.failed > 0) return { state: 'failed', count: tally.failed }
  if (tally.held > 0) return { state: 'held', count: tally.held }
  if (tally.reading > 0) return { state: 'reading', count: tally.reading }
  if (withUnplaced && tally.unplaced > 0) return { state: 'unplaced', count: tally.unplaced }
  if (tally.readable > 0) return { state: 'allRead', count: tally.readable }
  return null
}
