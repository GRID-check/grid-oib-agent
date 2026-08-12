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
  deleteSessionDocumentsByIds,
  listSessionDocumentsForCleanup,
  SESSION_DOCUMENT_LIST_LIMIT,
} from './repository'

/** Bound the best-effort backend call that purges an ingested doc's RAG chunks. */
const BACKEND_FETCH_TIMEOUT_MS = 10_000

/**
 * Remove one stored document's objects: the file, the ingest pipeline's
 * `_thumb.jpg` sibling, and the `_bim/` derivatives an IFC extraction wrote
 * underneath it.
 *
 * Best-effort throughout — the row delete that follows is the record of intent,
 * and an object that is already gone is the outcome we wanted anyway.
 */
export async function deleteDocumentObjects(doc: Pick<Document, 'storageKey' | 'storageBucket'>): Promise<void> {
  if (!doc.storageKey) return
  try {
    const bucket = resolveDocumentBucket(doc.storageBucket)
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: doc.storageKey }))
    const thumbKey = buildThumbnailStorageKey(doc.storageKey)
    if (thumbKey) {
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: thumbKey })).catch(() => undefined)
    }
    await deleteBimDerivedObjects(doc.storageKey, doc.storageBucket).catch(() => undefined)
  } catch {
    // ignore — the object may already be gone; the row delete is the record of intent
  }
}

/**
 * Purge the ingested chunks for a set of filenames in one collection.
 *
 * Best-effort: a backend hiccup must not block the durable SeaweedFS + Postgres
 * cleanup, so failures are swallowed exactly as they are on the project and
 * Archiv delete paths. Chunks may linger until the next collection reconcile.
 */
export async function purgeCollectionChunks(collectionName: string, filenames: string[]): Promise<void> {
  if (filenames.length === 0) return
  try {
    await fetch(`${getBackendUrl()}/v1/collections/${encodeURIComponent(collectionName)}/documents`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_ids: filenames }),
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
  } catch {
    // ignore — see above
  }
}

/**
 * Erase every file attached to a conversation: its chunks, its objects, its
 * rows.
 *
 * The foreign key would take the rows on its own when the conversation is
 * deleted (`ON DELETE CASCADE`, migration 0046), and that is exactly why this
 * exists: a cascade cannot reach SeaweedFS or Chroma, so relying on it would
 * leave the bytes behind — invisible to every listing, invisible to the storage
 * ledger, and reachable by anyone who could presign the key.
 *
 * Called BEFORE the conversation row goes, so the rows this reads are still
 * there. Paged, because the listing is bounded: a conversation with more
 * attachments than one page would otherwise keep its surplus objects forever.
 * Idempotent — running it against an already-clean conversation does nothing.
 */
export async function purgeSessionDocuments(
  conversationId: string,
  organizationId: string,
): Promise<void> {
  // Read → delete objects → repeat. Each pass deletes the rows it just handled,
  // so the next page is genuinely the next page rather than the same one.
  for (;;) {
    const docs = await listSessionDocumentsForCleanup(conversationId, organizationId)
    if (docs.length === 0) break

    const byCollection = new Map<string, string[]>()
    for (const doc of docs) {
      byCollection.set(doc.collectionName, [...(byCollection.get(doc.collectionName) ?? []), doc.filename])
    }
    for (const [collectionName, filenames] of byCollection) {
      await purgeCollectionChunks(collectionName, filenames)
    }

    for (const doc of docs) {
      await deleteDocumentObjects(doc)
    }

    // Only the rows this pass actually erased. Deleting the whole conversation
    // here would drop rows whose objects are still in the next page, and those
    // bytes would then be nameless.
    await deleteSessionDocumentsByIds(
      docs.map((doc) => doc.id),
      organizationId,
      conversationId,
    )

    // A short conversation is the common case and it is done in one pass; only
    // a full page can possibly have more behind it.
    if (docs.length < SESSION_DOCUMENT_LIST_LIMIT) break
  }
}
