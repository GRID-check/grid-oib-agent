/**
 * What the Dateien listing is narrowed by, and the ordering it is shown in.
 *
 * Pure and outside the component for the same reason `file-sort.ts` is: a
 * predicate is logic, and logic in a render function can only be tested by
 * mounting a React tree.
 *
 * ## Why this file grew a type instead of the workspace growing two more `useState`s
 *
 * The header held its filters as loose state — one enum, one boolean — and each
 * new one cost a prop on the strip, a branch in the empty-state notice and
 * another chip in a row that was already the widest thing on the page. One
 * record makes the set open-ended: the menu renders it, `applyFileFilters`
 * answers it, and `activeFilterCount` says how many are on without anybody
 * enumerating them at the call site.
 */

import { inferDocumentKind, type DocumentKind } from '../document-kind'
import type { FileItem } from '../components/project-file-workspace'
import { readStateOf } from './folder-knowledge'

/** Who is on the hook — `Alle · Meine · Unvergeben`, one at a time. */
export type AssignmentFilter = 'all' | 'mine' | 'unassigned'

/**
 * The three answers a person actually wants from a status.
 *
 * The raw vocabulary has ten-odd values (`pending`, `ingesting`, `processing`,
 * `uploaded`, `ingested`, `success`, …) that differ only in which stage of the
 * pipeline emitted them. Nobody filters for `ingesting` as opposed to
 * `processing`; they ask "what is broken", "what is not ready yet" and "what
 * can Piloti cite". The grouping is not a second vocabulary: it is a view of
 * `readStateOf` (folder-knowledge), which reads `DOCUMENT_STATUS_FACTS`, so a
 * status is declared once and every surface that groups it agrees.
 * `file-sort.ts` ranks through {@link statusGroupOf} for the same reason.
 */
export type FileStatusGroup = 'failed' | 'processing' | 'ready'

export const FILE_STATUS_GROUPS: readonly FileStatusGroup[] = ['failed', 'processing', 'ready']

/**
 * The group a raw status is in, or `null` when it is in none of the three.
 *
 * - `readable` → `ready`: Piloti can cite it. Covers every indexed spelling
 *   (`ready`, `ingested`, `success`, `completed`, `processed`).
 * - `reading` → `processing`: in flight, or unknown.
 * - `failed` → `failed`.
 * - `held` (the content screen stopped it) and `unindexed` (stored on purpose,
 *   or the birth status `uploaded`) → `null`. Neither is being read, neither
 *   is citable, and neither failed, so no status filter claims them.
 *
 * An unknown status is `reading` (see `readStateOf`), so it lands in
 * processing and never in ready. Calling something citable that is not is the
 * error that wastes an afternoon; a new state under "in Arbeit" until somebody
 * declares it is the harmless direction to be wrong in.
 */
export function statusGroupOf(status: string | null | undefined): FileStatusGroup | null {
  switch (readStateOf(status)) {
    case 'readable':
      return 'ready'
    case 'reading':
      return 'processing'
    case 'failed':
      return 'failed'
    case 'held':
    case 'unindexed':
      return null
  }
}

/** The kinds the menu offers, in the order it offers them. */
export const FILE_KIND_FILTERS: readonly DocumentKind[] = [
  'floorplan',
  'section',
  'siteplan',
  'notice',
  'photo',
  'model',
  'sheet',
  'text',
  'document',
]

export interface FileFilters {
  assignment: AssignmentFilter
  /**
   * Answered by the SERVER, not by `applyFileFilters`.
   *
   * `authoredBy=agent` is a query parameter on the listing endpoint, so this
   * flag is part of the filter set the menu shows and the count reports, but
   * the workspace refetches on it instead of filtering in the browser. Applying
   * it here as well would be a second, divergent definition of the same word.
   */
  agentAuthoredOnly: boolean
  /**
   * Only the documents whose newest version is waiting for a decision
   * (`in_review`) — „Freigabe ausstehend".
   *
   * Answered HERE, unlike `agentAuthoredOnly`, because the listing already
   * carries each row's version state (`toDocumentWireRow`): asking the endpoint
   * for a second narrowing would be a second definition of the same word and a
   * round trip for a field the browser is holding.
   */
  reviewPendingOnly: boolean
  /**
   * Show the documents somebody archived, beside the active ones.
   *
   * Answered by the SERVER like `agentAuthoredOnly` and for the same reason,
   * one step stronger: an archived document is not IN the default listing at
   * all (`lifecycle = 'active'` is in the query, ADR-0054), so no amount of
   * predicate here could bring it back. The workspace refetches with
   * `?includeArchived=true`.
   *
   * It WIDENS where every other filter narrows, and that asymmetry is
   * deliberate: „archiviert" is a statement that the file has left the working
   * set, so the working set is the default and asking for the rest is the
   * gesture.
   */
  includeArchived: boolean
  /** Empty means every kind — an empty set is "no constraint", never "nothing". */
  kinds: readonly DocumentKind[]
  /** Empty means every status, for the same reason. */
  statuses: readonly FileStatusGroup[]
  /**
   * Ingestion tags, lower-cased — a document matches when it carries ANY of
   * them. The Archiv's category chips were this, as a row of their own over a
   * grid of their own; as a filter they work on every shelf and under every
   * folder, and an empty set is no constraint like the others.
   */
  tags: readonly string[]
}

/** One tag the loaded documents really carry, and how many do. */
export interface TagOption {
  /** Lower-cased: what `FileFilters.tags` holds. */
  key: string
  /** As the first document spelled it. */
  label: string
  count: number
}

/**
 * The tags actually present on the loaded documents, most frequent first (ties:
 * locale alphabetical). Nothing is invented: a shelf without tagged documents
 * offers no tag filter at all.
 */
export function tagOptions(files: readonly FileItem[], locale: string): TagOption[] {
  const counts = new Map<string, TagOption>()
  for (const file of files) {
    // Topics sit beside the controlled tags in the one „Kategorie" filter: to a
    // person both are words Piloti put on the file, and two menus for them would
    // ask the reader to know which list a word came from.
    for (const tag of new Set([...(file.tags ?? []), ...(file.topics ?? [])])) {
      const key = tag.toLowerCase()
      const entry = counts.get(key)
      if (entry) entry.count += 1
      else counts.set(key, { key, label: tag, count: 1 })
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label, locale)
  )
}

export const NO_FILE_FILTERS: FileFilters = {
  assignment: 'all',
  agentAuthoredOnly: false,
  reviewPendingOnly: false,
  includeArchived: false,
  kinds: [],
  statuses: [],
  tags: [],
}

/**
 * How many constraints are on — the number on the Filter button.
 *
 * Each dimension counts once however many values it holds: "Dateityp: Grundriss
 * + Schnitt" is one constraint the reader can lift, and counting it as two
 * makes the badge a tally of clicks rather than of narrowing. `canCollaborate`
 * is taken because assignment is not offered at all without it, and a badge
 * must never count a filter its menu does not show.
 */
export function activeFilterCount(filters: FileFilters, canCollaborate: boolean): number {
  let count = 0
  if (canCollaborate && filters.assignment !== 'all') count += 1
  if (filters.agentAuthoredOnly) count += 1
  if (filters.reviewPendingOnly) count += 1
  if (filters.includeArchived) count += 1
  if (filters.kinds.length > 0) count += 1
  if (filters.statuses.length > 0) count += 1
  if (filters.tags.length > 0) count += 1
  return count
}

/** Toggle one value in a filter dimension, preserving the offered order. */
export function toggleIn<T>(values: readonly T[], value: T, order: readonly T[]): T[] {
  const next = values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
  return order.filter((candidate) => next.includes(candidate))
}

export interface FileFilterContext {
  canCollaborate: boolean
  currentUserId?: string
}

/**
 * Narrow a listing. Returns the input array itself when nothing is constrained,
 * so an unfiltered corpus keeps its identity and does not re-render everything
 * downstream on every keystroke elsewhere.
 */
export function applyFileFilters<T extends FileItem>(
  files: readonly T[],
  filters: FileFilters,
  { canCollaborate, currentUserId }: FileFilterContext
): readonly T[] {
  const assignment = canCollaborate ? filters.assignment : 'all'
  const constrained =
    assignment !== 'all' ||
    filters.reviewPendingOnly ||
    filters.kinds.length > 0 ||
    filters.statuses.length > 0 ||
    filters.tags.length > 0
  if (!constrained) return files

  return files.filter((file) => {
    if (assignment === 'unassigned' && (file.assignees?.length ?? 0) > 0) return false
    if (
      assignment === 'mine' &&
      !file.assignees?.some((person) => person.userId === currentUserId)
    ) {
      return false
    }
    if (filters.statuses.length > 0) {
      // A file in none of the groups (held, unindexed) matches no status filter.
      const group = statusGroupOf(file.status)
      if (group === null || !filters.statuses.includes(group)) return false
    }
    // A row whose version state is unknown (a listing that did not read it) is
    // not „ausstehend": the honest answer to a question nobody asked is no.
    if (
      filters.tags.length > 0 &&
      ![...(file.tags ?? []), ...(file.topics ?? [])].some((tag) => filters.tags.includes(tag.toLowerCase()))
    ) {
      return false
    }
    if (filters.reviewPendingOnly && file.versionState !== 'in_review') return false
    if (filters.kinds.length > 0) {
      const kind = inferDocumentKind({
        filename: file.filename,
        contentType: file.contentType,
        tags: file.tags,
      })
      if (!filters.kinds.includes(kind)) return false
    }
    return true
  })
}
