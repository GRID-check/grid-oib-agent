/**
 * The filename namespace a publishable Piloti document is filed under.
 *
 * ## The collision this closes
 *
 * `documents.filename` is the join key to the retrieval index: the ingest
 * pipeline replaces a document's passages by name, and every chunk carries that
 * name in its metadata. `generatedFilename` builds `slug(title)-YYYY-MM-DD.ext`
 * out of a title THE MODEL WROTE, into the project's own collection — so a
 * report about a Sicherheitskonzept lands on the filename of the
 * Sicherheitskonzept it was written from, on the same day. That was harmless
 * only while nothing machine-authored was ever indexed. The moment a published
 * agent document reaches `/v1/ingest`, the collision means Piloti's own
 * document replaces a human document's passages.
 *
 * A `piloti/` prefix makes the two sets DISJOINT rather than merely unlikely to
 * meet, and it does so structurally: no browser on any platform produces a file
 * whose name contains `/`, so the three upload shelves cannot present a name in
 * this namespace whatever the person types. The document id inside it is what
 * keeps two Piloti documents apart when the model writes the same title twice.
 *
 * ## Why the slash survives everywhere it has to
 *
 * - **The object key.** `storageKeySegment` flattens `/` to `_`, so the stored
 *   key stays one flat segment under `doc/<id>/` exactly as it is today. The
 *   filing path therefore keys the OBJECT off the bare name and the ROW off the
 *   namespaced one — see `fileGeneratedDocument`, which says so at the call.
 * - **The backend URL.** `collectionFileUrl` percent-encodes the filename, and
 *   `collection-file-ref.spec.ts` has asserted since it was written that a name
 *   containing a slash cannot climb out of its collection.
 * - **The chunk metadata.** The BFF now STATES the name on `POST /v1/ingest`
 *   (`file_name`) instead of letting the backend derive it from the presigned
 *   URL's last path segment, which is the object key's basename and therefore
 *   the flattened form. Stating it is what keeps the row, the chunks and the
 *   purge on one string.
 *
 * Pure and dependency-free, because both the producer (`generated.ts`, which is
 * `server-only`) and the branded join constructor (`collection-file-ref.ts`,
 * which is deliberately not) need the same answer.
 */

/**
 * The one prefix. `piloti/` and not `Piloti/` or `_piloti/`: it is read by
 * people in a Files pane and by `LIKE 'piloti/%'` in migration 0083, and a
 * capital letter would make those two disagree the first time somebody
 * lower-cased a name.
 */
export const AGENT_DOCUMENT_NAMESPACE = 'piloti/'

/**
 * `piloti/<document id>/<name>` — the row's filename from the moment the
 * document is created.
 *
 * Set at CREATION and not at ingest, because the two would otherwise be
 * different strings for one document: `documents.filename` is the chunk join
 * key, `renameDocument` never touches it, and every purge
 * (`purgeIngestedChunks`, `purgeCollectionChunks`, `reindexProject`'s delete)
 * addresses the backend with the value on the row. A namespace applied only on
 * the way into the index would index under one name and purge under another,
 * which is the exact shape of the leak `collection-file-ref.ts` exists to stop
 * — an addressable pair that names somebody else's document.
 */
export function agentDocumentFilename(documentId: string, name: string): string {
  return `${AGENT_DOCUMENT_NAMESPACE}${documentId}/${name}`
}

/**
 * Whether a filename sits inside the namespace.
 *
 * The question a caller actually has is "may this row address backend state",
 * and the prefix is only half the answer — see {@link
 * collectionFileRef}, which asks this AND whether the row has a published
 * version. Exported on its own so the migration's predicate, this check and the
 * producer all read one constant.
 */
export function isAgentDocumentFilename(filename: string): boolean {
  return filename.startsWith(AGENT_DOCUMENT_NAMESPACE)
}
