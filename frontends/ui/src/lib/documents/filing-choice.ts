/**
 * What the person filing a file chose about it, kept on the document's row
 * until the bytes it was chosen for have been read.
 *
 * Two choices travel with an upload's dispatch to `POST /v1/ingest`: the
 * document type (`ShelfUploadInput.documentType`, sent as `document_type`) and
 * the older document these bytes are the new Fassung of
 * (`ShelfUploadInput.revisionOf`, ADR-0099, sent as `revision_of`). The ingest
 * job stores both once it has read the file. A file the content screening holds
 * (ADR-0086) is never stored: the job stops at the verdict. The reviewer's
 * release later sends the same bytes again (`releaseQuarantinedDocument`), and
 * without the choice the classifier types the file and no Fassung is linked.
 *
 * So every dispatch that carries a choice records it in `documents.metadata`
 * under {@link FILING_CHOICE_METADATA_KEY}, beside the job id and the digest of
 * the bytes that job reads (`ingestContentHash`, `setDocumentIngestJob`). The
 * release reads it back from the row it already loaded, the same "read the
 * row, never trust the caller" argument `dispatchDocument` makes about the
 * file name, and only while the recorded digest is the row's: a choice made for
 * other bytes is not this file's. The Fassung is kept as the older document's
 * id and checked again at release (`resolveReleasedRevisionOf`), which sends
 * its name as it is then, or drops the choice when it no longer resolves.
 *
 * Only the release reads it. Every dispatch rewrites the metadata, so the next
 * one without a choice (a re-index, a placement move) drops it; were a re-index
 * to carry it, a person's later tag edit would be overwritten by the type chosen
 * at filing, which the ingest job treats as the newest choice.
 */

import type { Document } from '@/lib/db/schema'
import { documentTypeOf, type DocumentTypeTag } from './tag-vocabulary'

/** A document id as the row's primary key holds it. */
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The `documents.metadata` key the choice is kept under. */
export const FILING_CHOICE_METADATA_KEY = 'filingChoice'

export interface FilingChoice {
  documentType: DocumentTypeTag | null
  /**
   * The ID of the older document, as `resolveRevisionOf` checked it at upload. Never its
   * name: the release re-resolves it (`resolveReleasedRevisionOf`), since by then it may
   * be archived or renamed, or another file may carry its name.
   */
  revisionOfId: string | null
}

/**
 * The JSON a dispatch records for its choice, or null when it carries none (and
 * then nothing is recorded). Keys are present only when chosen.
 */
export function filingChoiceRecord(choice: Partial<FilingChoice>): Record<string, string> | null {
  const record: Record<string, string> = {}
  if (choice.documentType) record.documentType = choice.documentType
  if (choice.revisionOfId) record.revisionOfId = choice.revisionOfId
  return Object.keys(record).length > 0 ? record : null
}

/**
 * The choice recorded with the row's last dispatch, when that dispatch read the
 * bytes the row holds now; null otherwise. A value outside the vocabulary (a
 * type retired since) reads as no type, as a queued job's does.
 */
export function storedFilingChoice(row: Pick<Document, 'metadata' | 'contentHash'>): FilingChoice | null {
  const metadata = asRecord(row.metadata)
  const stored = asRecord(metadata?.[FILING_CHOICE_METADATA_KEY])
  if (!metadata || !stored) return null
  if (!row.contentHash || metadata.ingestContentHash !== row.contentHash) return null
  const documentType = typeof stored.documentType === 'string' ? (documentTypeOf([stored.documentType]) ?? null) : null
  const revisionOfId =
    typeof stored.revisionOfId === 'string' && DOCUMENT_ID.test(stored.revisionOfId) ? stored.revisionOfId : null
  return documentType || revisionOfId ? { documentType, revisionOfId } : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
