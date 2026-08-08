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
 */
function isMissingBucket(error) {
  const name = error?.name ?? error?.Code
  return name === 'NoSuchBucket' || error?.$metadata?.httpStatusCode === 404
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
      const res = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      )
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
