/**
 * Ordering for the explorer's detail view.
 *
 * Pure and locale-aware, and deliberately not inside the component: sorting is
 * logic, and logic in a render function can only be tested by mounting a React
 * tree (see the note on `InputArea.spec.tsx` in AGENTS.md).
 */

import type { FileItem } from '../components/project-file-workspace'
import { documentDisplayName } from '@/lib/documents/display-name'

/** Columns the detail view can order by. */
export type FileSortKey = 'name' | 'status' | 'size' | 'added'

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
export function sortFiles(files: readonly FileItem[], sort: FileSort, locale?: string): FileItem[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
  const sign = sort.direction === 'asc' ? 1 : -1

  const compare = (a: FileItem, b: FileItem): number => {
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
