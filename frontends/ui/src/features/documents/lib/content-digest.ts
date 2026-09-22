'use client'

/**
 * The browser's half of `documents.content_hash`.
 *
 * Same value, same shape as the server's `@/lib/documents/content-digest`, and
 * it has to stay that way: this digest is compared against the one stored with
 * the bytes to decide whether a file in a folder re-upload has anything new to
 * say. A disagreement does not fail — it classifies every file as changed and
 * quietly puts a 500-file corpus back on the wire.
 *
 * It runs on a bounded set. The planner only asks for a digest where a file's
 * name AND size already match a document that HAS one, which is the only case
 * where the answer can be "unchanged"; everything else is an upload either way
 * and hashing it would be work spent to learn nothing.
 */

import { runWithConcurrency } from './upload-queue'

/** Must match `CONTENT_DIGEST_ALGORITHM` on the server. */
const ALGORITHM = 'sha256'

/**
 * How many files are read into memory at once.
 *
 * `arrayBuffer()` is the whole file in RAM, and a candidate can be a 150 MB
 * model. Two at a time keeps the peak bounded on a laptop while still hiding
 * most of the read latency behind the next one.
 */
const DIGEST_CONCURRENCY = 2

/**
 * `sha256:<hex>` for a file, or `null` when it cannot be computed.
 *
 * Null is a real answer and the callers treat it as one: `crypto.subtle` is
 * absent outside a secure context, a file can be unreadable because it moved
 * since it was picked, and a browser may refuse a buffer this large. Every one
 * of those means "I do not know whether this changed", and the safe reading of
 * that is that it did — the file is uploaded. Never the reverse.
 */
export async function digestFile(file: File): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  try {
    const buffer = await file.arrayBuffer()
    const digest = await subtle.digest('SHA-256', buffer)
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    return `${ALGORITHM}:${hex}`
  } catch {
    return null
  }
}

/**
 * Digest several files, bounded. Files whose digest could not be computed are
 * simply absent from the map, which is what makes them upload.
 */
export async function digestFiles(files: readonly File[]): Promise<Map<File, string>> {
  const digests = new Map<File, string>()
  if (files.length === 0) return digests
  const results = await runWithConcurrency(files, DIGEST_CONCURRENCY, (file) => digestFile(file))
  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value) digests.set(files[index], result.value)
  })
  return digests
}
