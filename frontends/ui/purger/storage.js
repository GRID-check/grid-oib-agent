/**
 * Prefix-based SeaweedFS cleanup. Paginated list + batched delete; a prefix with
 * no objects is a successful no-op (idempotent re-runs).
 */

const {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} = require('@aws-sdk/client-s3')

function createS3Client() {
  return new S3Client({
    endpoint: process.env.SEAWEED_ENDPOINT,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.SEAWEED_ACCESS_KEY || '',
      secretAccessKey: process.env.SEAWEED_SECRET_KEY || '',
    },
    forcePathStyle: true,
    // SeaweedFS 3.80 rejects the flexible-checksum headers AWS SDK v3.1077+
    // injects by default (matches lib/s3.ts): request checksums break the
    // DeleteObjects payload signing, response validation adds
    // x-amz-checksum-mode to GETs.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

/**
 * Is this "the bucket does not exist"?
 *
 * A bucket that does not exist holds no objects, so a prefix sweep over it has
 * already achieved what it was asked to do. This is not defensive coding: per-
 * organization buckets are created LAZILY, on an organization's first upload
 * (ADR-0043), so any organization that has not uploaded since the feature was
 * enabled — or ever — genuinely has no tenant bucket. Treating that as an error
 * would fail the purge AFTER it had already destroyed the Python-side stores,
 * retry ten times destroying them again, and then abandon the queue row
 * forever with the tenant's `projects`, `conversations` and FGA rows intact.
 *
 * EXACTLY that one error code, and nothing wider. This function's answer is
 * "there is nothing here to erase", and the purge acts on it by deleting the
 * rows that name the objects — so a false positive is a GDPR erasure that
 * reported success and removed only the pointers.
 *
 * A `404` alone is not the same statement. `NoSuchKey` is a 404. An endpoint
 * pointed at the filer's HTTP port instead of the S3 port answers 404. A
 * gateway that lost its route answers 404 in HTML. Every one of those is a
 * misconfiguration that should fail loudly and retry, and every one of them
 * would have been read as "already erased". The SDK lifts the XML `<Code>` into
 * `name`, and SeaweedFS answers a missing bucket with `NoSuchBucket`
 * (`weed/s3api/s3api_object_handlers_list.go`), so the code alone is both
 * necessary and sufficient.
 */
function isMissingBucket(error) {
  return error?.name === 'NoSuchBucket'
}

async function deleteStoragePrefix(s3, bucket, prefix) {
  let deleted = 0
  let continuationToken
  do {
    let page
    try {
      page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      )
    } catch (error) {
      if (isMissingBucket(error)) return deleted
      throw error
    }
    const keys = (page.Contents || []).map((obj) => ({ Key: obj.Key }))
    if (keys.length > 0) {
      // Quiet:true returns ONLY per-key errors. A 200 response can still carry
      // partial failures — if we ignore them the purge "succeeds", the grid_app
      // pointer is deleted, and the surviving objects become unrecoverable
      // orphans (a GDPR-erasure failure). Throw so the queue row retries.
      // Inside the same guard as the List. A bucket dropped between the two
      // calls throws here instead, and "the bucket is gone" means the same
      // thing at either point: there is nothing left to erase. Unreachable
      // today — nothing in the pipeline drops a bucket — but the guard costs a
      // line and its absence would be an erasure that failed for the one
      // reason that is not a failure.
      let res
      try {
        res = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys, Quiet: true },
          }),
        )
      } catch (error) {
        if (isMissingBucket(error)) return deleted
        throw error
      }
      if (res.Errors && res.Errors.length > 0) {
        const sample = res.Errors.slice(0, 3)
          .map((e) => `${e.Key}: ${e.Code}`)
          .join('; ')
        throw new Error(
          `SeaweedFS delete reported ${res.Errors.length} error(s) for prefix ${prefix}: ${sample}`,
        )
      }
      deleted += keys.length
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)
  return deleted
}

module.exports = { createS3Client, deleteStoragePrefix, isMissingBucket }
