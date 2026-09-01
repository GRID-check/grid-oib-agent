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

/** Who is on the hook — `Alle · Meine · Unvergeben`, one at a time. */
export type AssignmentFilter = 'all' | 'mine' | 'unassigned'

/**
 * The three answers a person actually wants from a status.
 *
 * The raw vocabulary has ten-odd values (`pending`, `ingesting`, `processing`,
 * `uploaded`, `ingested`, `success`, …) that differ only in which stage of the
 * pipeline emitted them. Nobody filters for `ingesting` as opposed to
 * `processing`; they ask "what is broken", "what is not ready yet" and "what
 * can Piloti cite". Grouping is done here rather than in the menu so the
 * mapping has one home — `file-sort.ts` ranks the same vocabulary and the two
 * must not drift.
 */
export type FileStatusGroup = 'failed' | 'processing' | 'ready'

export const FILE_STATUS_GROUPS: readonly FileStatusGroup[] = ['failed', 'processing', 'ready']

const STATUS_GROUP: Record<string, FileStatusGroup> = {
  failed: 'failed',
  error: 'failed',
  uploading: 'processing',
  pending: 'processing',
  processing: 'processing',
  ingesting: 'processing',
  ready: 'ready',
  uploaded: 'ready',
  ingested: 'ready',
  success: 'ready',
  completed: 'ready',
}

/**
 * An unknown status counts as `processing`, not as `ready`.
 *
 * The two are not symmetric: calling something ready when it is not tells a
 * reader Piloti can cite a document it cannot, and that is the error that
 * wastes an afternoon. A new pipeline state showing up under "in Arbeit" until
 * somebody maps it is the harmless direction to be wrong in.
 */
export function statusGroupOf(status: string | null | undefined): FileStatusGroup {
  return STATUS_GROUP[(status ?? '').toLowerCase()] ?? 'processing'
}

/** The kinds the menu offers, in the order it offers them. */
export const FILE_KIND_FILTERS: readonly DocumentKind[] = [
  'floorplan',
  'section',
  'siteplan',
  'notice',
  'photo',
  'model',
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
  /** Empty means every kind — an empty set is "no constraint", never "nothing". */
  kinds: readonly DocumentKind[]
  /** Empty means every status, for the same reason. */
  statuses: readonly FileStatusGroup[]
}

export const NO_FILE_FILTERS: FileFilters = {
  assignment: 'all',
  agentAuthoredOnly: false,
  kinds: [],
  statuses: [],
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
  if (filters.kinds.length > 0) count += 1
  if (filters.statuses.length > 0) count += 1
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
    assignment !== 'all' || filters.kinds.length > 0 || filters.statuses.length > 0
  if (!constrained) return files

  return files.filter((file) => {
    if (assignment === 'unassigned' && (file.assignees?.length ?? 0) > 0) return false
    if (
      assignment === 'mine' &&
      !file.assignees?.some((person) => person.userId === currentUserId)
    ) {
      return false
    }
    if (filters.statuses.length > 0 && !filters.statuses.includes(statusGroupOf(file.status))) {
      return false
    }
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
