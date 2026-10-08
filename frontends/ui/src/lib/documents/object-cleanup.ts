/**
 * Erasing what one stored document left in the object store.
 *
 * A document is never one object. The ingest pipeline writes `_thumb.jpg` as a
 * sibling of the file and the rasters it extracted from a PDF under an `_img/`
 * prefix beneath it, the BFF writes `_render.pdf` beside an office file as its
 * PDF rendition (ADR-0070), and the IFC pipeline writes its digest and index
 * under a `_bim/` prefix. All are rendered FROM the file — a floor plan, a
 * photo cut out of a plan set, a Word file turned PDF and a parsed building are
 * not less of a disclosure than the source — so an erasure that removes the
 * file and leaves any behind has not erased the document.
 *
 * Shared by every shelf. The session cleanup (`session-documents/cleanup.ts`)
 * was where this first became a reported result rather than a swallowed error;
 * the project and Archiv deletes go through {@link eraseDocumentObjectsOrKeepRow}
 * here too, so all three shelves erase the same objects and keep the row on the
 * same failure.
 */

import 'server-only'
import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { s3Client, buildImageDerivedPrefix, buildRenditionStorageKey, buildThumbnailStorageKey } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { deleteBimDerivedObjects } from '@/lib/bim/service'
import type { Document } from '@/lib/db/schema'
import { UpstreamError } from '@/lib/api/errors'
import { listDocumentVersionObjects } from './version-repository'

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

/**
 * Delete every object under a prefix, paged to exhaustion.
 *
 * The number of stored rasters is only known by listing, so the sweep lists.
 * Paged for the same reason the BIM sweep is (`lib/bim/service.ts`): a single
 * `ListObjectsV2` answers at most a page, and stopping there would leave the
 * rest in the bucket after the tenant was told the document is gone. A delete
 * that fails here throws, so the caller reports it rather than the row
 * disappearing over objects that stayed.
 */
async function deleteObjectsUnderPrefix(bucket: string, prefix: string): Promise<void> {
  let continuationToken: string | undefined
  do {
    const listed = await s3Client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    )
    for (const object of listed.Contents ?? []) {
      if (!object.Key) continue
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }))
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
  } while (continuationToken)
}

function resolveBucket(doc: StoredObjectRef): { bucket: string } | { failure: ExternalCleanupResult } {
  try {
    return { bucket: resolveDocumentBucket(doc.storageBucket) }
  } catch (error) {
    return { failure: { ok: false, reason: `bucket resolution: ${describeCleanupError(error)}` } }
  }
}

/**
 * Remove what the pipelines derived from a document — the `_thumb.jpg` and
 * `_render.pdf` siblings, the `_img/` rasters and the `_bim/` derivatives — and
 * leave the file itself in place.
 *
 * Written for the replace path, which no longer needs it: since ADR-0054 a
 * re-upload lands under its own `v<n>/` key (`versionWriteKey`), and every
 * derivative is keyed off the file's directory, so the new version's thumbnail,
 * rasters and building are written fresh beside it and the old version's stay
 * with the old version — history, erased when the document is. It remains the
 * second half of {@link deleteDocumentObjects}. Do not wire it into a
 * re-upload: it would erase the PREVIOUS version's derivatives.
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

  // Deleted unconditionally rather than only for office files: whether one was
  // written is not recorded anywhere but in the store, and a missing key is
  // success (`isAlreadyGone`), so asking costs one request and guessing could
  // leave a converted copy of a private file behind.
  const renditionKey = buildRenditionStorageKey(storageKey)
  if (renditionKey) {
    const rendition = await attemptObjectDelete(`rendition ${renditionKey}`, () =>
      s3Client.send(new DeleteObjectCommand({ Bucket: resolved.bucket, Key: renditionKey })),
    )
    if (!rendition.ok) return rendition
  }

  const imagePrefix = buildImageDerivedPrefix(storageKey)
  if (imagePrefix) {
    const images = await attemptObjectDelete(`stored rasters under ${imagePrefix}`, () =>
      deleteObjectsUnderPrefix(resolved.bucket, imagePrefix),
    )
    if (!images.ok) return images
  }

  return attemptObjectDelete(`bim derivatives of ${storageKey}`, () =>
    deleteBimDerivedObjects(storageKey, doc.storageBucket),
  )
}

/**
 * Remove one stored document's objects: the file, the ingest pipeline's
 * `_thumb.jpg` sibling and `_img/` rasters, the `_render.pdf` rendition of an
 * office file, and the `_bim/` derivatives an IFC extraction wrote underneath it.
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
 * Every part counts. The thumbnail, the rendition, the rasters and the `_bim/` derivatives are
 * rendered FROM the private file — a floor plan and a parsed building are not
 * less of a disclosure than the source — so a failure on any is a failure of
 * the erasure, not a cosmetic remainder.
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
 * Erase every stored object of a document — each version's file, `_thumb.jpg`,
 * `_render.pdf`, `_img/` rasters and `_bim/` derivatives — or throw and leave the row.
 *
 * Shared by the project and the Archiv delete, which used to delete the live
 * object by hand: the file, the thumbnail and `_bim/`, but never the `_img/`
 * rasters (up to 64 per document), with every failure swallowed and the row
 * deleted regardless. The row is the only handle a retry has
 * (`./object-cleanup`), so a swallowed failure was a private file nothing
 * lists, nothing can delete, and that presigning its key reads back. This is
 * the session delete's rule (`deleteSessionDocument`): the live object must go,
 * or the delete answers 502 and the document stays.
 *
 * A SUPERSEDED version's leftover stays best-effort, as it is there: the row
 * that guards access is the live one, and a version object that survives is an
 * orphan for the project purge's prefix sweep, not a document still reachable.
 */
export async function eraseDocumentObjectsOrKeepRow(
  doc: Pick<Document, 'id' | 'storageKey' | 'storageBucket'>,
  organizationId: string
): Promise<void> {
  for (const version of await listDocumentVersionObjects(doc.id, organizationId)) {
    if (version.storageKey === doc.storageKey) continue
    await deleteDocumentObjects(version).catch(() => undefined)
  }
  const objects = await deleteDocumentObjects(doc)
  if (objects.ok) return
  // The reason carries bucket names and upstream text: the log, not the client.
  console.error('[documents] delete aborted, row retained for retry:', doc.id, objects.reason)
  throw new UpstreamError('Deleting the document failed; nothing was removed. Please try again.')
}
