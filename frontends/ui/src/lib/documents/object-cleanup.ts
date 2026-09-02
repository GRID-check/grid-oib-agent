/**
 * Erasing what one stored document left in the object store.
 *
 * A document is never one object. The ingest pipeline writes `_thumb.jpg` as a
 * sibling of the file, and the IFC pipeline writes its digest and index under a
 * `_bim/` prefix beneath it. Both are rendered FROM the file — a floor plan and
 * a parsed building are not less of a disclosure than the source — so an
 * erasure that removes the file and leaves either behind has not erased the
 * document.
 *
 * Shared by every shelf. The session cleanup (`session-documents/cleanup.ts`)
 * was where this first became a reported result rather than a swallowed error,
 * and it lives here now because the replace-on-re-upload path of all three
 * shelves needs the same three deletes: a superseded row's derivatives are
 * stale the moment new bytes land, whether or not the file itself moved.
 */

import 'server-only'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { s3Client, buildThumbnailStorageKey } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { deleteBimDerivedObjects } from '@/lib/bim/service'
import type { Document } from '@/lib/db/schema'

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
export function describeCleanupError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 200)
}

/**
 * Whether an S3 failure means the object is ALREADY gone, which is the outcome
 * this module wants.
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
    return { ok: false, reason: `${what}: ${describeCleanupError(error)}` }
  }
}

type StoredObjectRef = Pick<Document, 'storageKey' | 'storageBucket'>

function resolveBucket(doc: StoredObjectRef): { bucket: string } | { failure: ExternalCleanupResult } {
  try {
    return { bucket: resolveDocumentBucket(doc.storageBucket) }
  } catch (error) {
    return { failure: { ok: false, reason: `bucket resolution: ${describeCleanupError(error)}` } }
  }
}

/**
 * Remove what the pipelines derived from a document — the `_thumb.jpg` sibling
 * and the `_bim/` derivatives — and leave the file itself in place.
 *
 * The replace path's half of the erasure. A re-upload under the same name
 * keeps the id, so the new bytes usually land on the old key, and the file
 * needs no delete; but the thumbnail and the parsed building beside it still
 * describe the OLD bytes. Until the new ingest overwrites them they are shown
 * as if current, and if that ingest fails they are shown that way for good.
 */
export async function deleteDerivedObjects(doc: StoredObjectRef): Promise<ExternalCleanupResult> {
  const storageKey = doc.storageKey
  if (!storageKey) return { ok: true }

  const resolved = resolveBucket(doc)
  if ('failure' in resolved) return resolved.failure

  const thumbKey = buildThumbnailStorageKey(storageKey)
  if (thumbKey) {
    const thumb = await attemptObjectDelete(`thumbnail ${thumbKey}`, () =>
      s3Client.send(new DeleteObjectCommand({ Bucket: resolved.bucket, Key: thumbKey })),
    )
    if (!thumb.ok) return thumb
  }

  return attemptObjectDelete(`bim derivatives of ${storageKey}`, () =>
    deleteBimDerivedObjects(storageKey, doc.storageBucket),
  )
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
export async function deleteDocumentObjects(doc: StoredObjectRef): Promise<ExternalCleanupResult> {
  const storageKey = doc.storageKey
  if (!storageKey) return { ok: true }

  const resolved = resolveBucket(doc)
  if ('failure' in resolved) return resolved.failure

  const object = await attemptObjectDelete(`object ${storageKey}`, () =>
    s3Client.send(new DeleteObjectCommand({ Bucket: resolved.bucket, Key: storageKey })),
  )
  if (!object.ok) return object

  return deleteDerivedObjects(doc)
}

/**
 * What a re-upload under a kept id owes the object store, done best-effort.
 *
 * The row is already correct by the time this runs, so a leaked object is the
 * wrong reason to fail the request; the failure goes to the operator's log
 * instead. The file is removed only when the new bytes did NOT land on top of
 * it — the key is derived from the id, which is preserved, but a project
 * re-upload into a different folder builds a different path — and the
 * derivatives are removed either way, because they describe the old bytes.
 */
export async function discardSupersededObjects(
  superseded: StoredObjectRef,
  currentStorageKey: string,
  shelf: string,
): Promise<void> {
  const result =
    superseded.storageKey === currentStorageKey
      ? await deleteDerivedObjects(superseded)
      : await deleteDocumentObjects(superseded)
  if (!result.ok) {
    console.error(`[${shelf}] failed to remove the superseded objects`, {
      storageKey: superseded.storageKey,
      reason: result.reason,
    })
  }
}
