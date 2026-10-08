/**
 * The last step of an upload: record the document, or take the bytes back.
 *
 * Its own module because both upload paths — project documents and the Archiv —
 * need exactly this sequence, and because it is the one place that knows the
 * object and the row can disagree. Putting it in `./service` would drag the S3
 * client into a module the upload hot path imports for quota arithmetic; putting
 * it in either upload path would mean two copies of a compensating delete.
 *
 * ## The invariant it maintains
 *
 * A `documents` row implies its object exists. That is what every read path
 * assumes, and it is why the object is written first and the row second.
 *
 * The cost of that order is this module: admission can refuse AFTER the bytes
 * have landed, and a refused upload must not leave an object nothing references.
 * An orphan there is worse than it sounds — it is invisible to the UI, invisible
 * to the quota ledger (which counts rows), and findable only by a bucket-wide
 * sweep — so the delete is not tidiness, it is the difference between a bounded
 * failure and a slow leak.
 *
 * The delete is best-effort by necessity: if it fails there is nothing useful
 * left to do, since the caller is already reporting the refusal. It is logged
 * with enough to find the object and nothing that identifies a person.
 */

import 'server-only'
import type { NewDocument } from '@/lib/db/schema'
import { discardObject } from './discard'
import { admitDocumentWithinQuota, admitReplacementWithinQuota } from './service'

/**
 * Insert the row if the organization has room, and delete the object if it does
 * not.
 *
 * Throws whatever admission threw — `InsufficientStorageError` on a refusal — so
 * the caller's error handling is unchanged from when the quota was checked before
 * the upload.
 *
 * The discard is on ANY failure of the insert, not only on a quota refusal, and
 * that breadth is depended on rather than incidental. `fileGeneratedDocument`
 * loses an idempotency race as a `23505` from this insert (migration 0064's
 * unique index): the losing caller has already PUT an object under its OWN
 * document id, so if the discard only covered refusals those bytes would stay
 * behind with no row pointing at them — invisible to the UI and to the quota
 * ledger, exactly the orphan this module exists to prevent.
 */
export async function admitOrDiscard(
  bucket: string,
  storageKey: string,
  values: NewDocument,
): Promise<void> {
  try {
    await admitDocumentWithinQuota(values)
  } catch (error) {
    await discardObject(bucket, storageKey)
    throw error
  }
}

/**
 * The replace-path twin of {@link admitOrDiscard}.
 *
 * Same compensation on refusal, for the same reason: the object is already
 * written, and the row was not changed, so nothing will ever reference those
 * bytes again. The difference is which object gets discarded — on refusal the
 * NEW one, because the old row still points at the old key.
 */
export async function admitReplacementOrDiscard(
  bucket: string,
  storageKey: string,
  organizationId: string,
  documentId: string,
  next: {
    storageKey: string
    storageBucket: string | null
    fileSize: number
    contentType: string | null
    contentHash: string | null
    folderId: string | null
    createdBy: string
  },
): Promise<void> {
  try {
    await admitReplacementWithinQuota(organizationId, documentId, next)
  } catch (error) {
    await discardObject(bucket, storageKey)
    throw error
  }
}
