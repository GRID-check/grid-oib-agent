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
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { s3Client } from '@/lib/s3'
import type { NewDocument } from '@/lib/db/schema'
import { admitDocumentWithinQuota } from './service'

/**
 * Insert the row if the organization has room, and delete the object if it does
 * not.
 *
 * Throws whatever admission threw — `InsufficientStorageError` on a refusal — so
 * the caller's error handling is unchanged from when the quota was checked before
 * the upload.
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

async function discardObject(bucket: string, storageKey: string): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }))
  } catch (error) {
    // Swallowed on purpose: the caller is already failing the request for a
    // reason the user can act on, and turning a quota refusal into a 500 would
    // hide it. The object becomes an orphan the purge will collect with its
    // project.
    console.error(
      '[storage] failed to remove the object for a refused upload',
      // The bucket and key, never the presigned URL — see
      // aiq_agent.common.log_redaction for the same rule on the Python side.
      { bucket, storageKey, cause: error instanceof Error ? error.name : 'unknown' },
    )
  }
}
