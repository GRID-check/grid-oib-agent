/**
 * The query a document listing accepts — shared by `GET /api/documents` and
 * `GET /api/archiv/documents`, because a shelf's listing is one thing
 * (ADR-0078) and the Files workspace builds the same URL for both.
 */

import { z } from 'zod'
import { DOCUMENT_AUTHORS, type DocumentAuthor } from './document-authors'
import {
  decodeDocumentListCursor,
  documentListCursorParam,
  type DocumentListCursor,
} from './list-cursor'

export const documentListFilterSchema = z.object({
  /**
   * Narrow the listing to what one kind of author wrote — the parameter behind
   * the „Von Piloti" filter chip.
   *
   * Validated against `DOCUMENT_AUTHORS` rather than accepted as a free string,
   * so a value the column cannot hold is a 400 here instead of a silently empty
   * result the caller reads as "Piloti has written nothing". The enum widens
   * with the tuple, which is the point of the tuple.
   */
  authoredBy: z.enum(DOCUMENT_AUTHORS).optional(),
  /**
   * Include the documents somebody archived (ADR-0054).
   *
   * Absent means active only, which is what „archiviert" has to mean or the
   * gesture does nothing a reader can see. `'true'` and not a bare presence
   * check, so the parameter reads the same way in a log line as it does in the
   * URL the Files pane builds.
   */
  includeArchived: z.literal('true').optional(),
  /** Where this page starts: the previous page's `nextCursor`. A malformed one is a 400. */
  cursor: documentListCursorParam,
})

export type DocumentListFilter = z.infer<typeof documentListFilterSchema>

/** The service options a parsed listing query stands for. */
export function documentListOptions(query: DocumentListFilter): {
  authoredBy?: DocumentAuthor
  includeArchived: boolean
  cursor?: DocumentListCursor
} {
  return {
    authoredBy: query.authoredBy,
    includeArchived: query.includeArchived === 'true',
    cursor: query.cursor ? (decodeDocumentListCursor(query.cursor) ?? undefined) : undefined,
  }
}
