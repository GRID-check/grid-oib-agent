/**
 * The base corpus's object-store side (ADR-0082): the platform-wide OIB norm
 * PDFs an admin uploads live in the PLATFORM bucket under `base-corpus/`.
 *
 * The backend holds a read-only SeaweedFS credential (ADR-0039), so it cannot
 * write or delete these objects itself. It asks this tier for a presigned PUT
 * and for the delete, exactly as it does for per-document rasters
 * (`presignDocumentImageUpload`). Platform data, not tenant data: no row is
 * read and no organization is involved.
 */

import 'server-only'
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { bucketName, buildBaseCorpusStorageKey, presignForBackend, s3Client } from '@/lib/s3'

/** Same expiry as the raster presign: the backend PUTs right after asking. */
const BASE_CORPUS_UPLOAD_EXPIRES_SECONDS = 3600

/**
 * One presigned PUT for a base-corpus PDF, signed for the backend that PUTs it
 * (`presignForBackend`). Throws `BadRequestError` for a name that is not a plain
 * `.pdf` basename.
 */
export async function presignBaseCorpusUpload(
  fileName: string
): Promise<{ uploadUrl: string; storageKey: string }> {
  const storageKey = buildBaseCorpusStorageKey(fileName)
  const uploadUrl = await presignForBackend(
    new PutObjectCommand({ Bucket: bucketName, Key: storageKey, ContentType: 'application/pdf' }),
    BASE_CORPUS_UPLOAD_EXPIRES_SECONDS
  )
  return { uploadUrl, storageKey }
}

/**
 * Remove one base-corpus PDF. Idempotent: S3 `DeleteObject` succeeds for a key
 * that does not exist, so a retry after a half-finished delete is a success.
 * Uses the BFF's write client, the one credential that may delete here.
 */
export async function deleteBaseCorpusObject(fileName: string): Promise<{ deleted: true }> {
  const storageKey = buildBaseCorpusStorageKey(fileName)
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: storageKey }))
  return { deleted: true }
}
