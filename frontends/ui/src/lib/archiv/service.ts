/**
 * Archiv service — business logic for the org-wide document Archiv.
 *
 * The Archiv is a hierarchical add-on on top of the existing documents domain
 * and, since ADR-0078, has folders like a project's Dateien:
 * an Archiv document is a `documents` row with `scope = 'archiv'`, `projectId`
 * NULL, and `collectionName = archiv_<orgId>`. That lets this service REUSE the
 * document pipeline wholesale — the SeaweedFS upload, the model-vs-ingest
 * dispatcher (`dispatchDocument`), the server-side upload allow-list (`assertUploadTypeAllowed`),
 * status reconciliation (`reconcileDocumentStatuses`), and the item routes
 * (download/preview/status/reingest/tags, which are scope-aware in
 * `lib/documents/service`). The ONLY thing that differs is authorization scope:
 * org-level (`org:archiv:manage` for writes, any member for reads) instead of
 * per-project FGA.
 *
 * Route handlers stay thin; failures are signalled with typed errors from
 * `@/lib/api/errors`.
 */

import 'server-only'
import { canManageArchiv } from '@/lib/authz/organizations'
import { recordAuditEvent } from '@/lib/audit/service'
import { getBackendUrl } from '@/lib/backend-proxy'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { fetchSemanticHits, joinHitsToFiles, type SearchedDocument } from '@/lib/documents/service'
import { collectionFileRef, purgeIngestedChunks } from '@/lib/documents/collection-file-ref'
import { ARCHIV_SHELF } from '@/lib/documents/shelf'
import { toListedDocuments, toListedPage, type ListedDocument } from '@/lib/documents/shelf-listing'
import { uploadToShelf, type UploadDocumentResult } from '@/lib/documents/shelf-upload'
import type { DocumentListCursor } from '@/lib/documents/list-cursor'
import type { DocumentNameMatchRow } from '@/lib/documents/repository'
import { eraseDocumentObjectsOrKeepRow } from '@/lib/documents/object-cleanup'
import { assertNoActiveHold } from '@/lib/compliance/holds'
import type { DocumentAuthor } from '@/lib/db/schema'
import type { AuthorizedSession } from '@/lib/auth/types'
import { archivCollectionName } from './collection'
import {
  deleteArchivDocument as deleteArchivDocumentRow,
  findArchivDocument,
  findArchivDocumentsByFilenames,
  findArchivDocumentsByNames,
  listArchivDocuments as listArchivDocumentRows,
} from './repository'

/** Bound the best-effort backend call that purges an ingested doc's RAG chunks. */
const BACKEND_FETCH_TIMEOUT_MS = 10_000

export interface ArchivListResult {
  documents: ListedDocument[]
  /**
   * Where the next page starts, or `null` when this page is the last. Opaque;
   * a client passes it back as `?cursor=` until it is `null`.
   */
  nextCursor: string | null
  collectionName: string
  /** Whether the caller may upload/delete (drives the read-only vs manage UI). */
  canManage: boolean
}

/**
 * One page of the org's Archiv (bounded, keyset-paginated), lazily reconciling
 * in-flight ingestion statuses with the backend and merging its read-only
 * document metadata — the exact same treatment, and the same options and rows,
 * `listDocumentsPage` gives a project's corpus (`toListedPage`, ADR-0078). Any
 * org member may read; the internal `metadata` jsonb never leaves the BFF.
 *
 * Archived documents have left the working set and are absent unless
 * `includeArchived` says otherwise; `authoredBy` narrows to one hand.
 */
export async function listArchiv(
  session: AuthorizedSession,
  options: { authoredBy?: DocumentAuthor; includeArchived?: boolean; cursor?: DocumentListCursor } = {},
): Promise<ArchivListResult> {
  const page = await listArchivDocumentRows(session.organizationId, options)
  return {
    ...(await toListedPage(session, page)),
    collectionName: archivCollectionName(session.organizationId),
    canManage: canManageArchiv(session),
  }
}

/**
 * Document-centric semantic search over the org's shared Archiv. Any org member
 * may read; resolves the org's `archiv_<orgId>` collection, runs the
 * deterministic vector search on the backend, and joins the hits to the
 * Archiv's file rows by filename. Fail-open: a backend error/timeout yields
 * `{ hits: [] }`, never a crash.
 *
 * The join looks the hit names up directly rather than reading the listing:
 * the listing is paged, and a hit on a document past its first page would
 * otherwise be dropped as if the search had not found it.
 */
export async function searchArchivDocuments(
  session: AuthorizedSession,
  query: string,
  topK = 20,
): Promise<{ hits: Array<SearchedDocument<ListedDocument>> }> {
  const hits = await fetchSemanticHits(archivCollectionName(session.organizationId), query, topK)
  if (hits.length === 0) return { hits: [] }
  const rows = await findArchivDocumentsByFilenames(
    session.organizationId,
    hits.map((hit) => hit.file_name),
  )
  return { hits: joinHitsToFiles(hits, await toListedDocuments(session, rows)) }
}

/**
 * The Archiv documents NAMED `filenames` (case-insensitive, either Unicode
 * form), as listing rows — the by-name resolve
 * (`POST /api/archiv/documents/by-name`). For the readers that want particular
 * documents (citations, surfaced-document cards), which used to look them up in
 * the listing's first page and missed every one past it. Any org member may
 * read, as with `listArchiv`.
 */
export async function resolveArchivDocumentsByName(
  session: AuthorizedSession,
  filenames: readonly string[],
): Promise<ListedDocument[]> {
  const rows = await findArchivDocumentsByFilenames(session.organizationId, filenames)
  return toListedDocuments(session, rows)
}

/**
 * Which of `names` the Archiv already holds — the upload planner's question,
 * asked of the database rather than of the paged listing (see
 * `probeProjectDocumentNames`). Any org member may read, as with `listArchiv`.
 */
export async function probeArchivDocumentNames(
  session: AuthorizedSession,
  names: readonly string[],
): Promise<DocumentNameMatchRow[]> {
  return findArchivDocumentsByNames(session.organizationId, names)
}

export type UploadArchivDocumentResult = UploadDocumentResult

/**
 * Store an uploaded file in SeaweedFS under the org's Archiv prefix, record it as
 * an `archiv`-scoped document, and hand it to the backend for ingestion into the
 * org's shared `archiv_<orgId>` collection — the Archiv's name for the
 * shelf-parameterised pipeline in `@/lib/documents/shelf-upload`, which a
 * project's Dateien share. Ingest is best-effort (the file is already durable in
 * SeaweedFS + Postgres); status reads reconcile the outcome. Requires
 * `org:archiv:manage`.
 *
 * `folderId` files the document into one of the Archiv's folders and
 * `originPath` records where a folder upload found it, as on a project.
 */
export function uploadArchivDocument(
  session: AuthorizedSession,
  file: File,
  request: Request,
  { folderId = null, originPath = null }: { folderId?: string | null; originPath?: string | null } = {},
): Promise<UploadArchivDocumentResult> {
  return uploadToShelf(session, ARCHIV_SHELF, { file, folderId, originPath }, request)
}

/**
 * Delete an Archiv document: purge its RAG chunks (best-effort), remove the
 * SeaweedFS object, delete the row, purge the chunks once more, and audit.
 * Requires `org:archiv:manage`.
 */
export async function deleteArchivDocument(
  session: AuthorizedSession,
  documentId: string,
  request: Request,
): Promise<void> {
  if (!canManageArchiv(session)) throw new ForbiddenError()

  const doc = await findArchivDocument(documentId, session.organizationId)
  if (!doc) throw new NotFoundError()
  // Before the first destructive step: a hold on the document, its uploader or
  // the organization refuses the delete with a 409 (`@/lib/compliance/holds`).
  await assertNoActiveHold(session.organizationId, 'document', documentId)

  // Best-effort: remove the ingested chunks so a deleted document stops showing
  // up in retrieval. A backend hiccup must not block the durable SeaweedFS + DB
  // cleanup below, so failures here are swallowed.
  //
  // Through `collectionFileRef` like every other `(collection, filename)` call,
  // and not because an Archiv row can be machine-authored today — it cannot,
  // since `fileGeneratedDocument` sets no scope and the column defaults to
  // `project`. That is a coincidence of a default, and this call is the exact
  // shape of the leak that deleted a human document's chunks: purge by
  // filename. `null` here means "not ours to purge", which is the right answer
  // for a row that owns no chunks whatever put it in this scope.
  const purgeRef = collectionFileRef(doc)
  // `null`: nothing of its own to purge. `false`: the backend did not confirm,
  // and the audit row says so — the platform vector reconcile is the sweep.
  const chunksPurged = purgeRef
    ? await purgeIngestedChunks(getBackendUrl(), purgeRef, BACKEND_FETCH_TIMEOUT_MS)
    : null

  // Every version's objects and derivatives, or a 502 and the row stays — the
  // same erasure the project delete runs (`eraseDocumentObjectsOrKeepRow`).
  await eraseDocumentObjectsOrKeepRow(doc, session.organizationId)

  await deleteArchivDocumentRow(documentId, session.organizationId)

  // Once more, now that the row is gone: an ingest of this document that
  // asked `GET /api/internal/document-exists` before the row went saw it,
  // and kept chunks it inserted after the first purge (ADR-0054, correction
  // 18). Any check from here on reads „gone“ and discards its own. Logged
  // inside, never thrown: the row is gone, and the orphan sweep is the net.
  if (purgeRef) await purgeIngestedChunks(getBackendUrl(), purgeRef, BACKEND_FETCH_TIMEOUT_MS)

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'archiv.document.deleted',
    targetType: 'document',
    targetId: documentId,
    metadata: { filename: doc.filename.slice(0, 200), collectionName: doc.collectionName, chunksPurged },
    request,
  })
}
