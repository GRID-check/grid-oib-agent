/**
 * The one way to name a document to the backend by `(collectionName, filename)`.
 *
 * The Python backend knows a document only as a filename inside a collection.
 * The BFF knows it as a row. Those are not the same identity, because
 * `generatedFilename` (`lib/documents/generated.ts`) builds
 * `slug(title)-YYYY-MM-DD.ext` out of a title THE MODEL WROTE — a report's own
 * H1, a diagram card's `title` — into the project's own `collectionName`. A
 * report about a Sicherheitskonzept therefore lands on the filename of the
 * Sicherheitskonzept it was written from, on the same day, in the same
 * collection. The collision is reachable by the model, not merely accidental.
 *
 * A machine-authored row owns backend state in exactly one case: its published
 * version, filed under the `piloti/` namespace (the guard in `dispatchDocument`,
 * and the `ingestPublished` effect that is its only agent-authored caller).
 * Every other machine-authored row has no chunks, no summary row, no page text
 * and no tags, so every `(collection, filename)` call it makes addresses
 * SOMEBODY ELSE'S document — reading their summary onto its own card, or
 * deleting their chunks when it is deleted.
 *
 * The rows the call sites hold already carry `authoredBy`. Carrying the column
 * is not enough, because nothing forces a caller to read it, so the join gets a
 * constructor instead of a convention. {@link collectionFileRef} is the only way
 * to obtain a {@link CollectionFileRef}, it cannot be called without a row that
 * states its authorship AND whether it has a published version, and it answers
 * `null` for a row that owns nothing over there. The URL builders below take a
 * ref and nothing else. A caller that forgets the question does not have the
 * value the call needs, and `CollectionFileRef | null` makes the compiler ask
 * what to do about the `null` — so the failure mode is "does not compile" rather
 * than "fails open at runtime, silently, against another tenant's document".
 *
 * ## What this does NOT cover
 *
 * - It cannot forbid string concatenation. Nothing in TypeScript stops a caller
 *   from writing the `/v1/collections/${c}/documents/${f}` template by hand. The
 *   gate is reached by reaching for it; it is not a wall. The Archiv delete and
 *   the session-document purge both go through the constructor. Their safety
 *   also rests on `fileGeneratedDocument` leaving `scope` unset, so its rows
 *   default to `project` and never appear in an `archiv` or `session` query, and
 *   a column default is not something to rely on alone.
 * - A machine-authored row is addressable only when it has a published version
 *   and its filename is in the `piloti/` namespace. A bare `authoredBy !== 'user'`
 *   check would refuse a published Piloti document (ADR-0054), which is
 *   machine-authored and does own chunks. Those two conditions are exactly when
 *   chunks of its own can exist, and both are asked of the ROW, so no caller can
 *   assert either.
 * - It is the BFF side only. The Python backend joins on `(collection,
 *   file_name)` with no notion of `authored_by`; this BFF is the sole authority
 *   on authorship, and anything else that talks to that backend is outside the
 *   guarantee.
 * - The reverse direction — backend asking the BFF to resolve a
 *   `(collection, filename)` pair — is gated in SQL instead
 *   (`findStorageKeyByCollectionAndFilename`), by a different mechanism in a
 *   different place.
 */

import type { DocumentAuthor } from '@/lib/db/schema'
import { isAgentDocumentFilename } from './agent-namespace'

declare const humanAuthored: unique symbol

/**
 * A `(collectionName, filename)` pair that has been shown to name a row which
 * owns backend state, and may therefore address it.
 *
 * The brand is called `humanAuthored`, a name that no longer describes all it
 * admits: a published machine-authored row owns backend state too.
 *
 * The brand is a `declare`d module-private symbol: no other module can name it,
 * so no other module can produce this type. {@link collectionFileRef} is the
 * only constructor.
 */
export interface CollectionFileRef {
  readonly collectionName: string
  readonly filename: string
  readonly [humanAuthored]: true
}

/**
 * The minimum a row must state to be turned into a ref.
 *
 * `authoredBy` is REQUIRED and typed as the union rather than `string`: a row
 * type that does not carry the column cannot be passed at all, and `undefined`
 * cannot be smuggled through as "probably a person". That is the same choice
 * `joinHitsToFiles` made for the search join, for the same reason — an optional
 * column lets a caller that forgets the `select` fail open.
 */
export interface AuthoredDocumentRow {
  collectionName: string
  filename: string
  authoredBy: DocumentAuthor
  /**
   * The version whose bytes the item's storage columns mirror, or `null` when
   * nothing has been published (ADR-0054).
   *
   * REQUIRED for the same reason `authoredBy` is, and it is the half of the
   * restated rule a caller would otherwise be free to leave out: a
   * machine-authored row has chunks of its own only after somebody published a
   * version of it, and an optional column would let every row that forgot the
   * `select` read as "published" or as "not published" by accident. `null` is
   * a legitimate answer for a human upload, which owns its chunks regardless.
   */
  publishedVersionId: string | null
}

/**
 * Turn a document row into the pair the backend can be addressed by, or `null`
 * when it must not be.
 *
 * `null` is not an error and not an outage: it is "this row owns nothing over
 * there". Callers translate it into whatever "nothing over there" means for
 * them — no metadata, no chunk purge, no page text, a 404 — but they cannot
 * ignore it, because there is no ref to make the call with.
 */
export function collectionFileRef(row: AuthoredDocumentRow): CollectionFileRef | null {
  // A machine-authored row is addressable only where chunks of its own can
  // exist, and that is exactly one place: a PUBLISHED version, filed under the
  // `piloti/` namespace. Both halves are load-bearing and neither implies the
  // other. Without the published check, a draft — which is never dispatched —
  // would purge a name it never wrote. Without the namespace check, a
  // machine-authored row from a producer that never filed under `piloti/` would
  // address `slug(model's title)-YYYY-MM-DD.ext` in the project's own collection,
  // which is the human document's name on the day the model reused its title.
  // `ingestPublished` refuses to dispatch such a row for the same reason, so
  // "indexed" and "addressable" stay the same set.
  if (row.authoredBy !== 'user') {
    if (!row.publishedVersionId) return null
    if (!isAgentDocumentFilename(row.filename)) return null
  }
  // The single documented widening in this module: the brand exists only in the
  // type system, so the constructed value cannot carry it. Confined here on
  // purpose — this assertion is what the rest of the codebase does NOT have to
  // re-derive.
  return { collectionName: row.collectionName, filename: row.filename } as CollectionFileRef
}

/**
 * `{backend}/v1/collections/{collection}/documents` — the collection-level file
 * endpoint, addressed on behalf of one specific document (chunk purge by
 * `file_ids`, collection listing consulted for one row's metadata).
 *
 * Takes a ref rather than a collection name even though the filename does not
 * appear in the path: the *reason* to call it is always one document, and the
 * filename rides in the body or the response join. A collection-only caller
 * that genuinely means the whole collection (the semantic-search POST, the
 * platform sweep) is a different operation and does not come through here.
 */
export const collectionDocumentsUrl = (backendUrl: string, ref: CollectionFileRef): string =>
  `${backendUrl}/v1/collections/${encodeURIComponent(ref.collectionName)}/documents`

/**
 * `{backend}/v1/collections/{collection}/documents/{filename}{suffix}` — the
 * per-file endpoints (`/tags`, `/display-title`, `/visual-details`).
 *
 * `suffix` includes its own leading slash so the caller reads as the route it
 * is calling.
 */
export const collectionFileUrl = (backendUrl: string, ref: CollectionFileRef, suffix: string): string =>
  `${collectionDocumentsUrl(backendUrl, ref)}/${encodeURIComponent(ref.filename)}${suffix}`


/**
 * Ask the backend to forget a document's chunks, summary row and text mirror.
 *
 * Returns whether the backend confirmed it. A `false` is logged and recorded
 * on the delete's audit event rather than swallowed: a deleted file whose
 * chunks linger keeps answering questions and keeps its name in the agent's
 * inventory, and the platform's vector reconcile is the only thing that
 * catches it — so the failure has to be visible somewhere a person looks.
 */
export async function purgeIngestedChunks(
  backendUrl: string,
  ref: CollectionFileRef,
  timeoutMs: number
): Promise<boolean> {
  try {
    const response = await fetch(collectionDocumentsUrl(backendUrl, ref), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_ids: [ref.filename] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      console.warn(`[documents] chunk purge refused for ${ref.collectionName}/${ref.filename}: HTTP ${response.status}`)
      return false
    }
    return true
  } catch (error) {
    console.warn(`[documents] chunk purge failed for ${ref.collectionName}/${ref.filename}`, error)
    return false
  }
}
