/**
 * The staged archive in object storage (ADR-0085): a multipart upload while the
 * browser sends it, one object while the job files it, nothing afterwards.
 *
 * The browser never talks to the store. Each part is a request to the BFF,
 * which checks who is sending it and writes it through as one S3 part; that
 * keeps the store's CORS and its public endpoint out of the design, and every
 * byte behind the same project permission as any upload. The parts are counted
 * and their ETags collected from the store itself when the upload completes, so
 * the client never has to report what it sent.
 */

import 'server-only'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
  type Part,
} from '@aws-sdk/client-s3'
import { bucketAdminS3Client, presignForBackend, s3Client } from '@/lib/s3'
import { ensureTenantBucketChecked } from '@/lib/storage/bucket'
import { ARCHIVE_URL_TTL_SECONDS, MAX_MULTIPART_PARTS } from './config'

export interface StagedArchive {
  bucket: string
  key: string
}

export interface UploadedPart {
  partNumber: number
  size: number
  etag: string
}

/**
 * Where an import's archive is staged: inside the PROJECT's prefix, which the
 * project purge erases (`purger/purge-project.js`), so deleting the project
 * mid-import cannot leave a mailbox behind in the bucket. One object per
 * import, never a person's file name.
 */
export function stagingKey(organizationId: string, projectId: string, importId: string): string {
  return `org/${organizationId}/project/${projectId}/mail-imports/${importId}/archive`
}

/** The organization's bucket, created on its first upload (ADR-0043). */
export function stagingBucket(organizationId: string): Promise<string> {
  return ensureTenantBucketChecked(bucketAdminS3Client, organizationId)
}

/** Start the multipart upload the parts go into. */
export async function beginStagedUpload(staged: StagedArchive): Promise<string> {
  const { bucket, key } = staged
  const created = await s3Client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: 'application/vnd.ms-outlook' }),
  )
  if (!created.UploadId) throw new Error('object storage started no multipart upload')
  return created.UploadId
}

/** The staged object's size, or null when there is none (yet). */
export async function stagedArchiveSize(staged: StagedArchive): Promise<number | null> {
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: staged.bucket, Key: staged.key }))
    return head.ContentLength ?? null
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
    if (status === 404 || (error as { name?: string } | null)?.name === 'NotFound') return null
    throw error
  }
}

/** Store one part. A part sent again replaces the earlier one, so a retried request is harmless. */
export async function putStagedPart(
  staged: StagedArchive,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
): Promise<void> {
  await s3Client.send(
    new UploadPartCommand({
      Bucket: staged.bucket,
      Key: staged.key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: body.byteLength,
    }),
  )
}

/** Every part the store holds for the upload, in order. */
export async function listStagedParts(staged: StagedArchive, uploadId: string): Promise<UploadedPart[]> {
  const parts: UploadedPart[] = []
  let marker: string | undefined
  do {
    const page = await s3Client.send(
      new ListPartsCommand({ Bucket: staged.bucket, Key: staged.key, UploadId: uploadId, PartNumberMarker: marker }),
    )
    for (const part of page.Parts ?? []) parts.push(toUploadedPart(part))
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined
  } while (marker && parts.length < MAX_MULTIPART_PARTS)
  return parts.sort((a, b) => a.partNumber - b.partNumber)
}

/** Join the parts into the one object the job reads. */
export async function completeStagedUpload(
  staged: StagedArchive,
  uploadId: string,
  parts: readonly UploadedPart[],
): Promise<void> {
  await s3Client.send(
    new CompleteMultipartUploadCommand({
      Bucket: staged.bucket,
      Key: staged.key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
    }),
  )
}

/** Throw the parts away. An upload already gone is not an error. */
export async function abortStagedUpload(staged: StagedArchive, uploadId: string): Promise<void> {
  try {
    await s3Client.send(
      new AbortMultipartUploadCommand({ Bucket: staged.bucket, Key: staged.key, UploadId: uploadId }),
    )
  } catch (error) {
    if (!isNoSuchUpload(error)) throw error
  }
}

/** Delete the staged archive. Deleting a key that is not there succeeds in S3. */
export async function deleteStagedArchive(staged: StagedArchive): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: staged.bucket, Key: staged.key }))
}

/** A GET the backend reads the archive through, against the in-network endpoint. */
export function archiveUrlForBackend(staged: StagedArchive): Promise<string> {
  return presignForBackend(new GetObjectCommand({ Bucket: staged.bucket, Key: staged.key }), ARCHIVE_URL_TTL_SECONDS)
}

function toUploadedPart(part: Part): UploadedPart {
  return { partNumber: part.PartNumber ?? 0, size: part.Size ?? 0, etag: part.ETag ?? '' }
}

/** Whether `error` is the store saying the multipart upload no longer exists. */
export function isNoSuchUpload(error: unknown): boolean {
  const name = (error as { name?: string; Code?: string } | null)?.name
  const code = (error as { Code?: string } | null)?.Code
  return name === 'NoSuchUpload' || code === 'NoSuchUpload'
}
