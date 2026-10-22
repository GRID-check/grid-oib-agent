/**
 * The staged objects of a held mail (ADR-0134, D6): the raw message as it
 * arrived, what the Python reader made of it (`read.json`), and one object per
 * attachment part. They live in the organization's bucket under the PROJECT's
 * reserved `_inbound-mail/<mail>/` prefix (`inboundMailStagingKey`), so the
 * project purge takes them, no person's folder can take the segment
 * (`lib/s3.ts`), and the migration's CHECKs hold every key a row names to that
 * exact shape. Erasure is by those keys, never by prefix.
 *
 * Nothing here decides anything; it moves bytes. A store fault is a 503 the
 * webhook's sender retries, or a throw the job's queue retries.
 */

import 'server-only'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { ServiceUnavailableError } from '@/lib/api/errors'
import { bucketAdminS3Client, presignForBackend, s3Client } from '@/lib/s3'
import { ensureTenantBucketChecked } from '@/lib/storage/bucket'

/** The media type of a stored raw message (RFC 5322 in an RFC 2046 body). */
export const RAW_MESSAGE_CONTENT_TYPE = 'message/rfc822'

/** How long the reader's presigned GET of the raw message lives: the read's own deadline and a margin. */
export const READ_URL_TTL_SECONDS = 15 * 60

/** The organization's bucket, created on its first object (ADR-0043). A store fault is a 503. */
export async function stagingBucketFor(organizationId: string): Promise<string> {
  try {
    return await ensureTenantBucketChecked(bucketAdminS3Client, organizationId)
  } catch {
    throw new ServiceUnavailableError('Object storage is unavailable', { reason: 'storage-unavailable' })
  }
}

/**
 * Write the raw message as it streams in, `length` bytes exactly. The body is
 * the checked stream `streamBodyTo` hands the webhook: it errors, rather than
 * ends, on a short, long or tampered body, so the upload fails rather than
 * completing over bad bytes. A store fault is a 503 (`storage-unavailable`).
 */
export async function putRawMessage(bucket: string, key: string, body: ReadableStream<Uint8Array>, length: number): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
      ContentLength: length,
      ContentType: RAW_MESSAGE_CONTENT_TYPE,
    }),
  )
}

/** Write one small staged object (an attachment part, `read.json`). */
export async function putStagedObject(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: contentType }),
  )
}

/** A staged object's bytes. */
export async function readStagedObject(bucket: string, key: string): Promise<Uint8Array> {
  const object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const bytes = await object.Body?.transformToByteArray()
  if (!bytes) throw new Error(`staged object ${key} has no body`)
  return bytes
}

/** A staged object as a stream of chunks, for a scan that never holds it whole. */
export async function streamStagedObject(bucket: string, key: string): Promise<AsyncIterable<Uint8Array>> {
  const object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const body = object.Body
  if (!body) throw new Error(`staged object ${key} has no body`)
  return body as unknown as AsyncIterable<Uint8Array>
}

/** A GET the Python reader fetches the raw message through, against the in-network endpoint. */
export function stagedObjectUrlForBackend(bucket: string, key: string): Promise<string> {
  return presignForBackend(new GetObjectCommand({ Bucket: bucket, Key: key }), READ_URL_TTL_SECONDS)
}

function isAlreadyGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return candidate.name === 'NoSuchKey' || candidate.$metadata?.httpStatusCode === 404
}

/**
 * Erase staged objects by their exact keys. Returns the keys that could NOT be
 * erased, which the caller keeps on its row so a sweep tries again; an object
 * already gone counts as erased.
 */
export async function eraseStagedObjects(bucket: string, keys: readonly string[]): Promise<string[]> {
  const remaining: string[] = []
  for (const key of keys) {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    } catch (error) {
      if (!isAlreadyGone(error)) remaining.push(key)
    }
  }
  return remaining
}
