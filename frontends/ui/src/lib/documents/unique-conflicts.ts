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
 * {@link retryRacedUpload} is the project and Archiv shelves' answer to the
 * first one; `forkDraftVersion` re-reads the winner for the second. The third
 * error here, {@link ReplacedDocumentGoneError}, is no index at all: a
 * re-upload whose document was deleted underneath it, answered by the same
 * retry. {@link DocumentDeletedError} is the last window: a delete that lands
 * after the upload's own write, before its version is recorded — a 409, not
 * retried.
 *
 * No `server-only` and no drizzle: the two repositories import this, and the
 * unit specs construct the errors directly.
 */

import { ConflictError } from '@/lib/api/errors'
import { isForeignKeyViolation, isUniqueViolation } from '@/lib/db/errors'

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

/**
 * The two foreign keys a version holds on its document. The composite one binds
 * the project and is MATCH SIMPLE, so it checks nothing when `project_id` is
 * NULL (the Archiv and session shelves); the plain one (migration 0094) holds
 * for every shelf. Either names a document that is gone.
 */
export const VERSION_DOCUMENT_FKS = [
  'document_versions_document_id_fkey',
  'document_versions_document_id_project_id_fkey',
] as const

/**
 * The document a version was being recorded for was deleted first.
 *
 * Thrown by the version inserts on a foreign-key refusal, and by
 * `recordUploadedVersion` when the document is already gone when it looks.
 * Not retried: the delete committed AFTER the upload's own write, so in commit
 * order this is "upload, then delete", and the file being gone is the delete's
 * outcome — re-creating it would undo a decision somebody else just made.
 */
export class DocumentDeletedError extends ConflictError {
  constructor(readonly documentId: string, options?: { cause?: unknown }) {
    super('The file was deleted while this upload was being recorded', {
      reason: 'deleted_during_upload',
    })
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** The mapped error for an insert into `document_versions`, or the original. */
export function mapVersionInsertError(error: unknown, documentId: string): unknown {
  if (isUniqueViolation(error, OPEN_VERSION_INDEX)) {
    return new OpenVersionExistsError(documentId, { cause: error })
  }
  if (VERSION_DOCUMENT_FKS.some((name) => isForeignKeyViolation(error, name))) {
    return new DocumentDeletedError(documentId, { cause: error })
  }
  return error
}

/**
 * A re-upload's document was deleted between its name probe and its update.
 *
 * `replaceDocumentWithinQuota` matched no row. Its transaction rolled back, so
 * nothing was charged, and `admitReplacementOrDiscard` deleted the object the
 * upload stored for it. A `ConflictError`, so a shelf that does not retry (the
 * session shelf) still answers 409 rather than a 200 over an orphaned object.
 */
export class ReplacedDocumentGoneError extends ConflictError {
  constructor(readonly documentId: string) {
    super('The file this upload was replacing was just deleted', { reason: 'replaced_document_gone' })
  }
}

/**
 * Run one upload attempt — probe, store, admit — and run it once more when the
 * shelf changed under the probe: a concurrent FIRST upload of the same filename
 * won it, or the document a re-upload was replacing was deleted.
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
 * ## Why a re-upload of a deleted document becomes a first upload, not a 409
 *
 * The same argument from the other side. Delete `Grundriss_EG.pdf`, then drop
 * it again, and the drop is a first upload under a new id, because the name is
 * free. A delete landing between the re-upload's probe and its update is that
 * sequence with the two steps overlapping. The person dropping the file asked
 * for it to be on the shelf; a 409 would tell them to do by hand exactly what
 * the retry does. There is no history to attach to either way: the delete
 * walked every version of the document and took them with it.
 *
 * What makes the second attempt safe:
 *
 *   - the first attempt left nothing behind. The refused insert or the
 *     zero-row update rolled back (no row changed, no quota charge), and
 *     `admitOrDiscard` / `admitReplacementOrDiscard` deleted its object on the
 *     throw — both discard on ANY failure of the admission;
 *   - `attempt` re-probes, so the second run takes the path the shelf now calls
 *     for: the winner's re-upload path, charged in full for the object it keeps
 *     under a fresh `v<n>/<write id>/` key, or a first upload under a new id.
 *
 * Once, not a loop: a second loss means the shelf changed twice during one
 * request, and the typed error propagates as a 409.
 */
export async function retryRacedUpload<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    if (!(error instanceof LiveFilenameTakenError) && !(error instanceof ReplacedDocumentGoneError)) {
      throw error
    }
    return attempt()
  }
}
