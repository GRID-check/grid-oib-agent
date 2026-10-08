/**
 * The by-name resolve's wire contract: "give me the rows of THESE documents"
 * (ADR-0055 — the routes, the client and the tests share it).
 *
 * A reader that wants particular documents — a citation chip, a
 * surfaced-documents card, a file operation naming its file — must not look the
 * name up in the first page of the listing. The listing is paged, so a document
 * older than the newest 500 would resolve to nothing: a dead chip on a correct
 * citation. This asks the database the reader's own question.
 *
 * Matching is by FILENAME, case-insensitive and in either Unicode form, which
 * is how every reader compares a name the model wrote with the name on the
 * row. The answer is the listing row (`toDocumentWireRow`), so a resolved row
 * and a listed row are the same shape.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { z } from 'zod'
import { FILENAME_LOOKUP_MAX_NAMES } from './filename-lookup'

const names = z.array(z.string().min(1).max(1024)).min(1).max(FILENAME_LOOKUP_MAX_NAMES)

export const archivByNameRequestSchema = z.object({ names })
export const projectByNameRequestSchema = z.object({ projectId: z.string().min(1), names })

/**
 * The response, parsed as far as a reader relies on it: the identity fields
 * are checked, the rest of the listing row passes through untouched.
 */
export const byNameResponseSchema = z.object({
  documents: z.array(
    z
      .object({ id: z.string(), filename: z.string(), createdAt: z.string() })
      .passthrough()
  ),
})
