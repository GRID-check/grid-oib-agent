/**
 * The digest recorded on `documents.content_hash`, defined once.
 *
 * Three shelves store bytes — a project's corpus, the org-wide Archiv, and a
 * conversation's attachments — and all three have to agree about what the
 * column holds, because the browser compares its own digest against it. Two
 * copies of `createHash('sha256')` would agree today and be one refactor away
 * from a prefix, a hex case or an algorithm that only one of them changed; a
 * mismatch there does not fail, it just classifies every file as changed and
 * quietly puts the whole folder back on the wire.
 *
 * The value carries its algorithm (`sha256:<64 lowercase hex>`) so a second one
 * can be introduced without a migration that cannot tell the two apart, and so
 * a reader of the column can see what it is looking at.
 *
 * It is an equality check, never a trust boundary. The client hashes a file it
 * already holds and this tier hashes the bytes it is about to write; the two are
 * compared to answer "is this the same file", and the client's value is never
 * stored.
 */

import 'server-only'
import { createHash } from 'node:crypto'

/** The algorithm prefix on every value this module produces. */
export const CONTENT_DIGEST_ALGORITHM = 'sha256'

/** `sha256:<hex>` for the given bytes. */
export function contentDigest(bytes: Buffer | Uint8Array): string {
  return `${CONTENT_DIGEST_ALGORITHM}:${createHash(CONTENT_DIGEST_ALGORITHM).update(bytes).digest('hex')}`
}
