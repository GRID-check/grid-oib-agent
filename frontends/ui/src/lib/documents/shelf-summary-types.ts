/**
 * The wire shape of a shelf's summary (`GET /api/documents/summary`,
 * `GET /api/archiv/documents/summary`, ADR-0102): what Postgres alone can say
 * about every document on the shelf, counted rather than listed.
 *
 * The Files workspace reads a folder LEVEL page by page, so it no longer holds
 * the corpus the folder tiles and the folder brief used to be folded from.
 * This is what they are folded from instead: one row per folder with the
 * documents filed DIRECTLY in it, by read-state family. The browser folds the
 * rows up its folder tree (`foldTallies`, `features/documents/lib/folder-knowledge.ts`),
 * so a walk through the tree costs no request.
 *
 * No `server-only`: the browser imports the types.
 */

import type { DocumentReadFamily } from './document-status'

/** The documents filed directly in one folder (`folderId: null` is the shelf root), by family. */
export type ShelfFolderTally = { folderId: string | null; total: number; latest: string | null } & Record<
  DocumentReadFamily,
  number
>

export interface ShelfSummary {
  /** One row per folder that holds a document this reader may see; a folder with none has no row. */
  folders: ShelfFolderTally[]
  /**
   * The documents whose read failed and may read differently now, newest
   * first, at most {@link SHELF_SUMMARY_FAILED_LIMIT}: what „Alle erneut lesen“
   * sends back through ingestion, filtered to a subtree by the browser. A file
   * that failed for a lasting reason (`lib/documents/retry-policy.ts`) is in the
   * folder tallies and not here.
   */
  failed: Array<{ id: string; folderId: string | null }>
  /** Whether more failed documents exist than `failed` carries. */
  failedTruncated: boolean
}

/** The most failed documents one summary names. The counts are exact either way. */
export const SHELF_SUMMARY_FAILED_LIMIT = 1000

/** The most folder rows one summary carries; a shelf has far fewer folders than this. */
export const SHELF_SUMMARY_FOLDER_LIMIT = 10_000
