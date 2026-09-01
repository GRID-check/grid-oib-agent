/**
 * Ordering for the explorer's detail view.
 *
 * Pure and locale-aware, and deliberately not inside the component: sorting is
 * logic, and logic in a render function can only be tested by mounting a React
 * tree (see the note on `InputArea.spec.tsx` in AGENTS.md).
 */

import type { FileItem } from '../components/project-file-workspace'
import { documentDisplayName } from '@/lib/documents/display-name'

/**
 * Columns the detail view can order by.
 *
 * `relevance` only exists for a semantic result set — a ranked list, where
 * ordering by anything else silently throws the ranking away.
 */
export type FileSortKey = 'name' | 'status' | 'size' | 'added' | 'relevance'

export type SortDirection = 'asc' | 'desc'

export interface FileSort {
  key: FileSortKey
  direction: SortDirection
}

/**
 * Sort order for the status column: what still needs the user's attention
 * first, what is finished last. Alphabetical would put "failed" between
 * "citable" and "processing" and bury the one row that needs acting on.
 */
const STATUS_RANK: Record<string, number> = {
  failed: 0,
  error: 0,
  uploading: 1,
  pending: 2,
  processing: 2,
  ingesting: 2,
  ready: 3,
  uploaded: 3,
  ingested: 3,
  success: 3,
  completed: 3,
}

const statusRank = (status: string | null): number => STATUS_RANK[(status ?? '').toLowerCase()] ?? 4

/**
 * A listing row MAY carry semantic match evidence (`SemanticHit`), and only the
 * score participates in ordering. Typed as an optional member rather than cast
 * at the read site, so a plain `FileItem[]` is still assignable.
 */
export type ScoredFile = FileItem & { score?: number }

/** Unranked rows sort BELOW every ranked one rather than above them. */
const scoreOf = (file: ScoredFile): number => file.score ?? -1

const timeOf = (iso: string): number => {
  const value = new Date(iso).getTime()
  return Number.isNaN(value) ? 0 : value
}

/**
 * The default when a column is first clicked.
 *
 * Names read forwards; everything else is more useful biggest/newest/most
 * urgent first, which is what a person means when they click "Size".
 */
export function defaultDirectionFor(key: FileSortKey): SortDirection {
  return key === 'name' ? 'asc' : 'desc'
}

/** The order a semantic result set arrives in, and the one it should keep. */
export const RELEVANCE_SORT: FileSort = { key: 'relevance', direction: 'desc' }

/**
 * What an unsorted listing is actually sorted by: newest first.
 *
 * Lives here rather than in the detail view because the ORDER is no longer that
 * view's property — the workspace holds it and both views read it, so the
 * default has to be reachable from outside the component that used to own it.
 */
export const DEFAULT_FILE_SORT: FileSort = { key: 'added', direction: 'desc' }

/** Toggle a sort: same column flips direction, a new column takes its default. */
export function nextSort(current: FileSort, key: FileSortKey): FileSort {
  if (current.key !== key) return { key, direction: defaultDirectionFor(key) }
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
}

/**
 * Order a listing. Returns a new array; the input is untouched.
 *
 * Filenames compare with a NUMERIC collator, so `Plan_2` sorts before
 * `Plan_10` — a set of drawings is numbered, and lexicographic order scatters
 * it. Ties always fall back to the filename so the order is total: a sort with
 * ties resolved arbitrarily reshuffles rows under the cursor on every refresh.
 */
export function sortFiles<T extends ScoredFile>(files: readonly T[], sort: FileSort, locale?: string): T[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
  const sign = sort.direction === 'asc' ? 1 : -1

  const compare = (a: T, b: T): number => {
    switch (sort.key) {
      case 'name':
        // Sort by what the column SHOWS. Ordering a list by a name the reader
        // cannot see reads as a broken sort.
        return collator.compare(documentDisplayName(a), documentDisplayName(b))
      case 'status':
        return statusRank(a.status) - statusRank(b.status)
      case 'size':
        return (a.fileSize ?? 0) - (b.fileSize ?? 0)
      case 'added':
        return timeOf(a.createdAt) - timeOf(b.createdAt)
      case 'relevance':
        return scoreOf(a) - scoreOf(b)
    }
  }

  return [...files].sort((a, b) => {
    const primary = compare(a, b)
    if (primary !== 0) return primary * sign
    // The tiebreak stays on the FILE name: two documents can be given the same
    // display name, and a total order cannot rest on something ambiguous.
    return collator.compare(a.filename, b.filename)
  })
}
