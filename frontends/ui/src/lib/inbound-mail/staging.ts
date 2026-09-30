/**
 * The selected attachments of a mail that is accepted but not yet filed.
 *
 * The webhook answers inside the sender's SMTP window, so it cannot file; it
 * stages the attachments it selected and the drain files them later. Only the
 * selected attachments are written, never the raw message or the body.
 *
 * Where: `org/<org>/project/<project>/inbound-mail/<row>/<n>` in the bucket the
 * organization's next object goes to (ADR-0043), recorded on the row. Under
 * the PROJECT prefix on purpose: the purger's project sweep erases everything
 * there (`purger/purge-project.js`), so a project deleted with mail still
 * queued takes the mail along.
 */

import 'server-only'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { UpstreamError } from '@/lib/api/errors'
import type { StagedAttachment } from '@/lib/db/schema'
import { bucketAdminS3Client, s3Client } from '@/lib/s3'
import { ensureTenantBucketChecked } from '@/lib/storage/bucket'
import type { SelectedAttachment } from './types'

/** The prefix one delivery's staged objects share. */
export function stagingPrefix(organizationId: string, projectId: string, deliveryId: string): string {
  return `org/${organizationId}/project/${projectId}/inbound-mail/${deliveryId}/`
}

export interface StagingResult {
  bucket: string | null
  staged: StagedAttachment[]
}

/**
 * Write the attachments, or none of them: a failure part-way deletes what was
 * written and rethrows, so a delivery that is not queued leaves nothing behind.
 */
export async function stageAttachments(
  where: { organizationId: string; projectId: string; deliveryId: string },
  attachments: readonly SelectedAttachment[]
): Promise<StagingResult> {
  if (attachments.length === 0) return { bucket: null, staged: [] }
  const bucket = await ensureTenantBucketChecked(bucketAdminS3Client, where.organizationId)
  const prefix = stagingPrefix(where.organizationId, where.projectId, where.deliveryId)
  const staged: StagedAttachment[] = []
  try {
    for (const [index, attachment] of attachments.entries()) {
      const key = `${prefix}${index + 1}`
      await s3Client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: attachment.content, ContentType: attachment.contentType })
      )
      staged.push({
        key,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sha256: attachment.sha256,
        size: attachment.content.byteLength,
      })
    }
  } catch (error) {
    await deleteStagedObjects(bucket, staged)
    throw new UpstreamError('Object storage is unavailable', { operation: 'stageAttachments', cause: errorName(error) })
  }
  return { bucket, staged }
}

/**
 * One staged object's bytes. The SDK reads the body into a fresh buffer of its
 * own, never a shared one, so it is typed as the `ArrayBuffer`-backed view a
 * `File` accepts rather than copied into one.
 */
export async function readStagedObject(bucket: string, key: string): Promise<Uint8Array<ArrayBuffer>> {
  const object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const bytes = await object.Body?.transformToByteArray()
  if (!bytes) throw new UpstreamError('A staged attachment could not be read', { operation: 'readStagedObject' })
  return bytes as Uint8Array<ArrayBuffer>
}

function isAlreadyGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return candidate.name === 'NoSuchKey' || candidate.$metadata?.httpStatusCode === 404
}

/**
 * Delete staged objects. Returns the ones that could NOT be deleted, which the
 * caller keeps on the row so the staging backstop tries again; an object that
 * is already gone counts as deleted.
 */
export async function deleteStagedObjects(
  bucket: string | null,
  staged: readonly StagedAttachment[]
): Promise<StagedAttachment[]> {
  if (!bucket || staged.length === 0) return []
  const remaining: StagedAttachment[] = []
  for (const object of staged) {
    if (!(await deleteOne(bucket, object.key))) remaining.push(object)
  }
  return remaining
}

/** Whether the object is gone now, whoever deleted it. */
async function deleteOne(bucket: string, key: string): Promise<boolean> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch (error) {
    return isAlreadyGone(error)
  }
}

/** An error's class name for a log line: never its message, which may carry data. */
export function errorName(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const code = (error.cause as { code?: unknown } | undefined)?.code ?? (error as { code?: unknown }).code
  return typeof code === 'string' ? `${error.name}:${code}` : error.name
}
