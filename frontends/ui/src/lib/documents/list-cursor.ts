/**
 * The keyset cursor of a document listing — where the next page starts.
 *
 * A listing is ordered `created_at DESC, id ASC` (newest first, the id breaking
 * the ties a batch import produces). The cursor is the last row's position in
 * that order, and the next page is every row strictly after it. Unlike an
 * offset, it neither skips nor repeats a row when an upload lands between two
 * page reads.
 *
 * `createdAt` is carried as the column's own text at MICROSECOND precision, in
 * UTC, and never as a JS `Date`. Postgres stores microseconds and a `Date`
 * holds milliseconds, so a cursor built from the `Date` on the row sits up to
 * 999µs before the row it came from: the comparison `created_at < cursor` then
 * re-serves that row, and a tie inside the lost microseconds silently drops a
 * neighbour. The repository reads the text with `to_char(... 'US')` and
 * compares against `(text)::timestamp AT TIME ZONE 'UTC'`, which round-trips
 * exactly.
 *
 * Opaque on the wire (base64url JSON) so no client parses it, and validated on
 * the way back in, so a hand-edited cursor is a 400 rather than a query with a
 * value nobody checked.
 */

import { z } from 'zod'

/** One position in the `created_at DESC, id ASC` order. */
export interface DocumentListCursor {
  /** `YYYY-MM-DDTHH:MM:SS.ffffff`, UTC, as `to_char` wrote it. */
  createdAt: string
  id: string
}

/** The shape `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')` writes. */
const MICROSECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/

/** The `to_char` pattern that produces {@link DocumentListCursor.createdAt}. */
export const CURSOR_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US'

const cursorSchema = z.object({
  t: z.string().regex(MICROSECOND_UTC),
  i: z.string().uuid(),
})

/** Longest cursor the routes accept; a real one is well under 100 characters. */
export const DOCUMENT_LIST_CURSOR_MAX_LENGTH = 200

export function encodeDocumentListCursor(cursor: DocumentListCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt, i: cursor.id }), 'utf8').toString('base64url')
}

/** The cursor, or `null` for anything this module did not write. */
export function decodeDocumentListCursor(encoded: string): DocumentListCursor | null {
  if (encoded.length === 0 || encoded.length > DOCUMENT_LIST_CURSOR_MAX_LENGTH) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const result = cursorSchema.safeParse(parsed)
  if (!result.success) return null
  return { createdAt: result.data.t, id: result.data.i }
}

/**
 * The query-string field for a route that takes a cursor: optional, bounded,
 * and refused with a 400 when it does not decode.
 */
export const documentListCursorParam = z
  .string()
  .max(DOCUMENT_LIST_CURSOR_MAX_LENGTH)
  .refine((value) => decodeDocumentListCursor(value) !== null, { message: 'Invalid cursor' })
  .optional()
