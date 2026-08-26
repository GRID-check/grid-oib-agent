/**
 * Erasing a conversation's private attachments.
 *
 * Its own module, deliberately small, because two callers need it and one of
 * them must not pull in the other. `conversations/service` calls this when a
 * chat is discarded; `session-documents/service` is what creates those rows and
 * it calls `conversations/service` to make the thread real on first upload. A
 * direct import between the two services would be a cycle, so the piece both
 * need lives underneath both — the same arrangement as
 * `collaboration/cleanup.ts`.
 *
 * There is no session here on purpose. The caller has already authorized the
 * act (deleting a conversation is `owner`), and by the time this runs the
 * decision is made: this is the erasure, not the permission to erase.
 */

import 'server-only'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { s3Client, buildThumbnailStorageKey } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { getBackendUrl } from '@/lib/backend-proxy'
import { deleteBimDerivedObjects } from '@/lib/bim/service'
import type { Document } from '@/lib/db/schema'
import {
  collectionFileRef,
  type CollectionFileRef,
} from '@/lib/documents/collection-file-ref'
import {
  deleteSessionDocumentsByIds,
  listSessionDocumentsForCleanup,
  SESSION_DOCUMENT_LIST_LIMIT,
} from './repository'

/** Bound the backend call that purges an ingested doc's RAG chunks. */
const BACKEND_FETCH_TIMEOUT_MS = 10_000

/**
 * The outcome of erasing one piece of a document's EXTERNAL state.
 *
 * A result rather than a thrown error, and rather than nothing at all, because
 * the caller has a decision to make with it that neither of those shapes
 * permits: it must keep going (a chunk purge failing must not strand the
 * object) and it must remember (a row whose external state survived may not be
 * deleted). `reason` is for the operator's log line, never for the client — it
 * carries bucket names and upstream error text.
 */
export interface ExternalCleanupResult {
  ok: boolean
  /** Absent on success. */
  reason?: string
}

/** One line of upstream failure, bounded so a log line stays a log line. */
function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 200)
}

/**
 * Whether an S3 failure means the object is ALREADY gone, which is the outcome
 * this function wants.
 *
 * Idempotency is load-bearing here, not a nicety: a retry re-walks documents
 * whose object it already deleted, so treating "not there" as a failure would
 * make a partially-successful cleanup permanently unfinishable. SeaweedFS
 * answers 204 for a missing key like S3 does; this covers implementations and
 * proxies that answer 404 instead.
 */
function isAlreadyGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return candidate.name === 'NoSuchKey' || candidate.$metadata?.httpStatusCode === 404
}

async function attemptObjectDelete(what: string, run: () => Promise<unknown>): Promise<ExternalCleanupResult> {
  try {
    await run()
    return { ok: true }
  } catch (error) {
    if (isAlreadyGone(error)) return { ok: true }
    return { ok: false, reason: `${what}: ${describeError(error)}` }
  }
}

/**
 * Remove one stored document's objects: the file, the ingest pipeline's
 * `_thumb.jpg` sibling, and the `_bim/` derivatives an IFC extraction wrote
 * underneath it.
 *
 * **Reports whether the bytes are actually gone.** It used to swallow every
 * S3 failure, and the callers then deleted the row regardless — which is the
 * one thing that must not happen, because the row is the ONLY handle that can
 * ever drive a retry. A suppressed failure left a private file in the tenant's
 * bucket that nothing lists, nothing can delete, and that still counts against
 * the organization's storage quota; presigning its key was all it took to read
 * it back. An object that is already gone is still success (see
 * {@link isAlreadyGone}) — that is the outcome we wanted, and it is what makes
 * a retry able to finish.
 *
 * All three parts count. The thumbnail and the `_bim/` derivatives are rendered
 * FROM the private file — a floor plan and a parsed building are not less of a
 * disclosure than the source — so a failure on either is a failure of the
 * erasure, not a cosmetic remainder.
 */
export async function deleteDocumentObjects(
  doc: Pick<Document, 'storageKey' | 'storageBucket'>,
): Promise<ExternalCleanupResult> {
  const storageKey = doc.storageKey
  if (!storageKey) return { ok: true }

  let bucket: string
  try {
    bucket = resolveDocumentBucket(doc.storageBucket)
  } catch (error) {
    return { ok: false, reason: `bucket resolution: ${describeError(error)}` }
  }

  const object = await attemptObjectDelete(`object ${storageKey}`, () =>
    s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey })),
  )
  if (!object.ok) return object

  const thumbKey = buildThumbnailStorageKey(storageKey)
  if (thumbKey) {
    const thumb = await attemptObjectDelete(`thumbnail ${thumbKey}`, () =>
      s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: thumbKey })),
    )
    if (!thumb.ok) return thumb
  }

  return attemptObjectDelete(`bim derivatives of ${storageKey}`, () =>
    deleteBimDerivedObjects(storageKey, doc.storageBucket),
  )
}

/**
 * Purge the ingested chunks for a set of filenames in one collection.
 *
 * **A non-2xx is a failure.** `fetch` rejects only on a transport error, so the
 * previous version treated a 500 — or a 404 naming the wrong collection — as a
 * completed purge, and the caller then deleted the row that named those chunks.
 * The chunk text is the document's content: leaving it in the retrieval index
 * with no row to retry from means a later question can still be answered out of
 * a file the user deleted.
 */
/**
 * Refs rather than bare filenames, for the reason `collection-file-ref.ts`
 * gives: a filename is not an identity across authorship, and purging by one is
 * the exact shape that deleted a human document's chunks when a machine-written
 * report shared its name. Session rows cannot be machine-authored today —
 * `fileGeneratedDocument` sets no scope, so the column defaults to `project` —
 * but that is a coincidence of a default, and this signature is what stops it
 * mattering.
 */
export async function purgeCollectionChunks(
  collectionName: string,
  refs: CollectionFileRef[],
): Promise<ExternalCleanupResult> {
  if (refs.length === 0) return { ok: true }
  try {
    const response = await fetch(
      `${getBackendUrl()}/v1/collections/${encodeURIComponent(collectionName)}/documents`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: refs.map((ref) => ref.filename) }),
        signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
      },
    )
    if (!response.ok) {
      return { ok: false, reason: `chunk purge of ${collectionName} answered ${response.status}` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `chunk purge of ${collectionName}: ${describeError(error)}` }
  }
}

/**
 * What one conversation's purge achieved, and what it left for a retry.
 *
 * `ok` is the only thing a caller must branch on: false means at least one
 * document's external state survived, its row was kept so the retry can find
 * it, and the conversation row MUST NOT be deleted — the foreign key would
 * cascade those rows away and the bytes would become nameless.
 */
export interface SessionDocumentPurgeResult {
  ok: boolean
  /** Documents fully erased — chunks, objects and row. */
  purged: number
  /** Documents whose row was deliberately KEPT because their erasure failed. */
  retained: number
  /** One line per failure, for the operator's log. Never for a client. */
  failures: string[]
}

/**
 * Erase every file attached to a conversation: its chunks, its objects, its
 * rows.
 *
 * The foreign key would take the rows on its own when the conversation is
 * deleted (`ON DELETE CASCADE`, migration 0049), and that is exactly why this
 * exists: a cascade cannot reach SeaweedFS or Chroma, so relying on it would
 * leave the bytes behind — invisible to every listing, invisible to the storage
 * ledger, and reachable by anyone who could presign the key.
 *
 * Called BEFORE the conversation row goes, so the rows this reads are still
 * there. Paged, because the listing is bounded: a conversation with more
 * attachments than one page would otherwise keep its surplus objects forever.
 * Idempotent — running it against an already-clean conversation does nothing,
 * and re-running it after a partial failure resumes from the rows that survived.
 *
 * **A document whose external state could not be erased keeps its row.** That
 * row is the only handle that names the object and the chunks, so deleting it
 * is what turns a transient S3 or backend failure into permanently orphaned
 * private data. The caller learns this from `ok` and must not proceed to delete
 * the conversation.
 */
export async function purgeSessionDocuments(
  conversationId: string,
  organizationId: string,
): Promise<SessionDocumentPurgeResult> {
  const result: SessionDocumentPurgeResult = { ok: true, purged: 0, retained: 0, failures: [] }

  // Every row this call has already tried. Retained rows stay in the listing at
  // the same position, so without this the loop would re-read and re-attempt
  // the same page forever — the failure mode the old "delete the page, then
  // page again" shape could not have, because it always emptied what it read.
  const attempted = new Set<string>()

  // Read → erase externally → delete only the rows that are genuinely erased →
  // repeat.
  for (;;) {
    const page = await listSessionDocumentsForCleanup(conversationId, organizationId)
    const docs = page.filter((doc) => !attempted.has(doc.id))
    if (docs.length === 0) break
    for (const doc of docs) attempted.add(doc.id)

    // Chunks first and per collection, because the backend takes a batch of
    // filenames. A collection that fails marks EVERY document in it as
    // unerased: the call is one request and we cannot tell which of its
    // filenames survived.
    const byCollection = new Map<string, CollectionFileRef[]>()
    for (const doc of docs) {
      // A row this sweep must not purge by name is simply not added; it owns no
      // chunks, so there is nothing for the purge to do about it.
      const ref = collectionFileRef(doc)
      if (!ref) continue
      byCollection.set(doc.collectionName, [...(byCollection.get(doc.collectionName) ?? []), ref])
    }
    const failedCollections = new Map<string, string>()
    for (const [collectionName, filenames] of byCollection) {
      const chunks = await purgeCollectionChunks(collectionName, filenames)
      if (!chunks.ok) failedCollections.set(collectionName, chunks.reason ?? 'chunk purge failed')
    }

    const erasedIds: string[] = []
    for (const doc of docs) {
      // Attempted even when its chunks survived: erasing the object is progress
      // that the retry does not have to repeat, and an object already gone is
      // success for the retry too.
      const objects = await deleteDocumentObjects(doc)
      const chunkFailure = failedCollections.get(doc.collectionName)

      if (objects.ok && !chunkFailure) {
        erasedIds.push(doc.id)
        continue
      }
      result.retained += 1
      result.failures.push(`${doc.id}: ${objects.ok ? chunkFailure : objects.reason}`)
    }

    // Only the rows this pass actually erased. Deleting the whole conversation
    // here would drop rows whose objects are still in the next page — or whose
    // objects are still in the BUCKET — and those bytes would then be nameless.
    await deleteSessionDocumentsByIds(erasedIds, organizationId, conversationId)
    result.purged += erasedIds.length

    // A short conversation is the common case and it is done in one pass; only
    // a full page can possibly have more behind it. Retained rows occupy the
    // page they were read on, so a page that is entirely retained stops the
    // walk here — `ok: false` sends the whole thing to a retry anyway.
    if (page.length < SESSION_DOCUMENT_LIST_LIMIT) break
  }

  result.ok = result.retained === 0
  return result
}
