/**
 * The one way to name a document to the backend by `(collectionName, filename)`.
 *
 * ## The bug this closes, and why the previous four fixes did not
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
 * A machine-authored row owns NO backend state by construction: nothing
 * `authoredBy !== 'user'` is ever dispatched to `/v1/ingest` (the guard in
 * `dispatchDocument`), so it has no chunks, no summary row, no page text and no
 * tags. Every `(collection, filename)` call it makes therefore addresses
 * SOMEBODY ELSE'S document — reading their summary onto its own card, or
 * deleting their chunks when it is deleted.
 *
 * Five instances of that have now been found, one at a time:
 * `reindexProject`, `findStorageKeyByCollectionAndFilename`, `joinHitsToFiles`,
 * the metadata-enrichment pass in `reconcile-status`, and `deleteDocument`'s
 * chunk purge. Four of those five sites ALREADY HAD `authoredBy` in hand —
 * `getAccessibleDocument` returns the full `Document` row and `DocumentListRow`
 * has carried the column as required since migration 0063. Making the column
 * available is what had been tried; it is not what was missing. What was
 * missing is that nothing forced anyone to READ it.
 *
 * So the join gets a constructor instead of a convention. {@link
 * collectionFileRef} is the only way to obtain a {@link CollectionFileRef}, it
 * cannot be called without a row that states its authorship, and it answers
 * `null` for a row a machine wrote. The URL builders below take a ref and
 * nothing else. A caller that forgets the question does not have the value the
 * call needs, and `CollectionFileRef | null` makes the compiler ask what to do
 * about the `null` — so the failure mode is "does not compile" rather than
 * "fails open at runtime, silently, against another tenant's document".
 *
 * ## What this does NOT cover
 *
 * - It cannot forbid string concatenation. Nothing in TypeScript stops a future
 *   caller from writing the `/v1/collections/${c}/documents/${f}` template by
 *   hand. The gate is reached by reaching for it; it is not a wall.
 * - It gates on `authoredBy !== 'user'`, which encodes TODAY's invariant
 *   ("machine-authored ⇒ never indexed ⇒ owns no backend state"). A future
 *   producer that is machine-authored AND indexed — which `DocumentListRow`'s
 *   own comment anticipates — would need this rule restated, not reused.
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

declare const humanAuthored: unique symbol

/**
 * A `(collectionName, filename)` pair that has been shown to belong to a
 * human-authored row, and may therefore address backend state.
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
  if (row.authoredBy !== 'user') return null
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
