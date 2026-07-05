/**
 * Prefix-based MinIO cleanup. Paginated list + batched delete; a prefix with
 * no objects is a successful no-op (idempotent re-runs).
 */

const {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} = require('@aws-sdk/client-s3')

function createS3Client() {
  return new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY || '',
      secretAccessKey: process.env.MINIO_SECRET_KEY || '',
    },
    forcePathStyle: true,
  })
}

async function deleteMinioPrefix(s3, bucket, prefix) {
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
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      )
      deleted += keys.length
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)
  return deleted
}

module.exports = { createS3Client, deleteMinioPrefix }
