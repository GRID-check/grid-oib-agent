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
  })
}

async function deleteStoragePrefix(s3, bucket, prefix) {
  let deleted = 0
  let continuationToken
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
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

module.exports = { createS3Client, deleteStoragePrefix }
