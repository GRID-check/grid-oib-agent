/**
 * Take back one object nothing references, best-effort.
 *
 * Its own module, not a private helper of `./admission`, because two paths have
 * the same orphan to take back and must not each grow a copy: a refused upload
 * (`./admission`) and a version-content write (`writeVersionContent` in
 * `lib/documents/version-content.ts`), whose loser's bytes and whose draft's
 * previous object are named by no row once the swap has decided. Kept out of
 * `./admission` also because `generated.spec.ts` lists that module's importers
 * as the ways a `documents` row can come to exist, and deleting an object is
 * not one of them.
 *
 * Best-effort by necessity: when the delete fails there is nothing useful left
 * to do, since the caller is already reporting its outcome. It is logged with
 * enough to find the object and nothing that identifies a person.
 */

import 'server-only'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { s3Client } from '@/lib/s3'

export async function discardObject(bucket: string, storageKey: string): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }))
  } catch (error) {
    // Swallowed on purpose: the caller is already failing (or finishing) the
    // request for a reason the user can act on, and turning that into a 500
    // would hide it. The object becomes an orphan the purge collects with its
    // project.
    console.error(
      '[storage] failed to remove an object nothing references',
      // The bucket and key, never the presigned URL — see
      // aiq_agent.common.log_redaction for the same rule on the Python side.
      { bucket, storageKey, cause: error instanceof Error ? error.name : 'unknown' },
    )
  }
}
