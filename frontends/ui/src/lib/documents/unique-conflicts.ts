/**
 * The two unique indexes whose refusal is an OUTCOME, not a bug.
 *
 * Both are the database closing a race the application's probe cannot:
 *
 *   - `uniq_documents_live_name_per_collection` (migrations 0074/0077/0083):
 *     two FIRST uploads of one filename into one shelf both probe, both miss,
 *     and the second insert is refused;
 *   - `uniq_document_versions_open_per_document` (migration 0082): two forks of
 *     one document both see no open version, and the second insert is refused.
 *
 * The repository that runs the insert maps a 23505 on exactly that index to the
 * error here, and nothing else: a 23505 from any other constraint on either
 * table is a different fault and keeps its 500. Both errors ARE a
 * `ConflictError`, so a caller that does not recover still answers 409 rather
 * than 500 — the session shelf's upload, for one, which has no retry.
 * {@link retryLostFirstUpload} is the project and Archiv shelves' answer to the
 * first one; `forkDraftVersion` re-reads the winner for the second.
 *
 * No `server-only` and no drizzle: the two repositories import this, and the
 * unit specs construct the errors directly.
 */

import { ConflictError } from '@/lib/api/errors'
import { isUniqueViolation } from '@/lib/db/errors'

export const LIVE_NAME_INDEX = 'uniq_documents_live_name_per_collection'
export const OPEN_VERSION_INDEX = 'uniq_document_versions_open_per_document'

/** A concurrent first upload of this filename won the shelf. */
export class LiveFilenameTakenError extends ConflictError {
  constructor(readonly filename: string, options?: { cause?: unknown }) {
    super('A file with this name was just uploaded here', { reason: 'live_name_taken' })
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** A concurrent fork of this document opened its one draft first. */
export class OpenVersionExistsError extends ConflictError {
  constructor(readonly documentId: string, options?: { cause?: unknown }) {
    super('This document already has an open version', { reason: 'open_version_exists' })
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** The mapped error for an insert into `documents`, or the original. */
export function mapDocumentInsertError(error: unknown, filename: string): unknown {
  return isUniqueViolation(error, LIVE_NAME_INDEX)
    ? new LiveFilenameTakenError(filename, { cause: error })
    : error
}

/** The mapped error for an insert into `document_versions`, or the original. */
export function mapVersionInsertError(error: unknown, documentId: string): unknown {
  return isUniqueViolation(error, OPEN_VERSION_INDEX)
    ? new OpenVersionExistsError(documentId, { cause: error })
    : error
}

/**
 * Run one upload attempt — probe, store, admit — and run it once more when a
 * concurrent FIRST upload of the same filename won the shelf.
 *
 * ## Why the loser becomes a version, not a 409
 *
 * Two people drop `Grundriss_EG.pdf` into one project at the same moment. Both
 * probes miss, both PUT an object under their own new document id, and
 * `uniq_documents_live_name_per_collection` refuses the second insert. Done one
 * after the other, the second drop would have been a re-upload: a new version
 * of the first person's document (ADR-0054). Answering the concurrent case
 * differently would make the outcome depend on milliseconds, so it is not.
 *
 * What makes the second attempt safe:
 *
 *   - the first attempt left nothing behind. The refused insert rolled back (no
 *     row, no quota charge), and `admitOrDiscard` deleted its object on
 *     the throw — it discards on ANY failure of the insert;
 *   - `attempt` re-probes, so the second run finds the winner's row and takes
 *     the re-upload path: its bytes go under a fresh `v<n>/<write id>/` key of
 *     the WINNER's document and are charged in full by the replacement's
 *     admission, which is exactly what is kept.
 *
 * Once, not a loop: the second attempt inserts nothing, so it cannot meet the
 * index again. If it somehow does (the winner deleted and re-created in
 * between), the `LiveFilenameTakenError` propagates, and it is a 409.
 */
export async function retryLostFirstUpload<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    if (!(error instanceof LiveFilenameTakenError)) throw error
    return attempt()
  }
}
