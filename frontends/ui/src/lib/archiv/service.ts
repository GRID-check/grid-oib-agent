/**
 * Archiv service — business logic for the org-wide document Archiv.
 *
 * The Archiv is a hierarchical add-on on top of the existing documents domain:
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

import { assertUploadNameAllowed, auditScreeningOverride } from '@/lib/upload-screening/service'
import 'server-only'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import {
  s3Client,
  bucketAdminS3Client,
  buildArchivStorageKey,
} from '@/lib/s3'
import { ensureTenantBucketChecked } from '@/lib/storage/bucket'
import { canManageArchiv } from '@/lib/authz/organizations'
import { recordAuditEvent } from '@/lib/audit/service'
import { getBackendUrl } from '@/lib/backend-proxy'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import {
  assertFileSizeAllowed,
  assertUploadTypeAllowed,
  dispatchDocument,
  fetchSemanticHits,
  joinHitsToFiles,
  type SearchedDocument,
} from '@/lib/documents/service'
import { collectionFileRef, purgeIngestedChunks } from '@/lib/documents/collection-file-ref'
import { contentDigest } from '@/lib/documents/content-digest'
import { documentNameKey } from '@/lib/documents/name-match'
import { assertWithinStorageQuota } from '@/lib/storage/service'
import { admitOrDiscard, admitReplacementOrDiscard } from '@/lib/storage/admission'
import { retryRacedUpload } from '@/lib/documents/unique-conflicts'
import { reconcileDocumentStatuses, type DocumentMetadata } from '@/lib/documents/reconcile-status'
import { findLiveDocumentByFilename } from '@/lib/documents/repository'
import { eraseDocumentObjectsOrKeepRow } from '@/lib/documents/object-cleanup'
import { assertNoActiveHold } from '@/lib/compliance/holds'
import {
  nextVersionNumber,
  recordUploadedVersionOrDiscard,
  summarizeDocumentVersions,
} from '@/lib/documents/lifecycle'
import { newVersionWriteId, versionWriteKey } from '@/lib/documents/version-content'
import type { DocumentListRow, DocumentNameMatchRow } from '@/lib/documents/repository'
import type { AuthorizedSession } from '@/lib/auth/types'
import { archivCollectionName } from './collection'
import {
  deleteArchivDocument as deleteArchivDocumentRow,
  findArchivDocument,
  findArchivDocumentsByFilenames,
  findArchivDocumentsByNames,
  listArchivDocuments as listArchivDocumentRows,
} from './repository'
import { encodeDocumentListCursor, type DocumentListCursor } from '@/lib/documents/list-cursor'

/** Bound the best-effort backend call that purges an ingested doc's RAG chunks. */
const BACKEND_FETCH_TIMEOUT_MS = 10_000

type ArchivListedDocument = Omit<DocumentListRow, 'metadata'> &
  DocumentMetadata & {
    /**
     * How many versions the document has; `null` without a version row.
     * The chat peek reads it to say a failed re-upload is still cited
     * through its previous version — the same count `/api/documents`
     * carries for a project file.
     */
    versionCount: number | null
  }

export interface ArchivListResult {
  documents: ArchivListedDocument[]
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
 * Reconcile in-flight statuses and attach version counts — what a listing
 * row needs before it leaves the BFF, whichever query found it.
 */
async function toArchivListedDocuments(
  session: AuthorizedSession,
  rows: DocumentListRow[],
): Promise<ArchivListedDocument[]> {
  const reconciled = await reconcileDocumentStatuses(rows, session.organizationId)
  const versions = await summarizeDocumentVersions(
    session.organizationId,
    reconciled.map((row) => row.id),
  )
  return reconciled.map(({ metadata: _metadata, ...row }) => ({
    ...row,
    versionCount: versions.get(row.id)?.versionCount ?? null,
  }))
}

/**
 * One page of the org's Archiv (bounded, keyset-paginated), lazily reconciling
 * in-flight ingestion statuses with the backend and merging its read-only
 * document metadata — the exact same treatment `listDocuments` gives a
 * project's corpus. Any org member may read; the internal `metadata` jsonb
 * never leaves the BFF.
 */
export async function listArchiv(
  session: AuthorizedSession,
  { cursor }: { cursor?: DocumentListCursor } = {},
): Promise<ArchivListResult> {
  const page = await listArchivDocumentRows(session.organizationId, { cursor })
  return {
    documents: await toArchivListedDocuments(session, page.rows),
    nextCursor: page.nextCursor ? encodeDocumentListCursor(page.nextCursor) : null,
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
): Promise<{ hits: Array<SearchedDocument<ArchivListedDocument>> }> {
  const hits = await fetchSemanticHits(archivCollectionName(session.organizationId), query, topK)
  if (hits.length === 0) return { hits: [] }
  const rows = await findArchivDocumentsByFilenames(
    session.organizationId,
    hits.map((hit) => hit.file_name),
  )
  return { hits: joinHitsToFiles(hits, await toArchivListedDocuments(session, rows)) }
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
): Promise<ArchivListedDocument[]> {
  const rows = await findArchivDocumentsByFilenames(session.organizationId, filenames)
  return toArchivListedDocuments(session, rows)
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

export interface UploadArchivDocumentResult {
  documentId: string
  jobId: string | null
  /** `processing` is the IFC path — see `UploadDocumentResult`. */
  status: 'pending' | 'uploaded' | 'failed' | 'processing'
  filename: string
}

/**
 * Store an uploaded file in SeaweedFS under the org's Archiv prefix, record it as an
 * `archiv`-scoped document, and hand it to the backend for ingestion into the
 * org's shared `archiv_<orgId>` collection. Ingest is best-effort (the file is
 * already durable in SeaweedFS + Postgres); status reads reconcile the outcome.
 * Requires `org:archiv:manage`.
 */
export async function uploadArchivDocument(
  session: AuthorizedSession,
  file: File,
  request: Request,
  /** See `UploadDocumentInput.screeningRelease`. */
  options: { screeningRelease?: boolean } = {},
): Promise<UploadArchivDocumentResult> {
  if (!canManageArchiv(session)) throw new ForbiddenError()
  // The name gate's server-side repeat (ADR-0077), before a byte is stored.
  const nameGate = await assertUploadNameAllowed(
    session.organizationId,
    { filename: file.name },
    options.screeningRelease === true,
  )
  await assertUploadTypeAllowed(session, file.name)
  assertFileSizeAllowed(file.size, file.name)
  // Same org ceiling as the project path — the Archiv shares the tenant's
  // bytes, so it must not be a way around the quota (ADR-0042).
  await assertWithinStorageQuota(session.organizationId, file.size)

  const collectionName = archivCollectionName(session.organizationId)
  // Same replace-on-re-upload rule as the project path, for the same reason and
  // through the same helpers — see `uploadDocument`. The Archiv is not a
  // different filing system; it is the same table with `scope = 'archiv'`, so a
  // second upload of one filename left the same paid-for ghost here.
  // One Unicode form, for the same reason and through the same helper as the
  // project shelf: this is the same table and the same unique name, so a
  // decomposed name off a Mac would put a second row here too. See
  // `@/lib/documents/name-match`.
  const filename = documentNameKey(file.name)

  // Same provisioning step as the project path (ADR-0043): the Archiv shares
  // the tenant's bucket, because it shares the tenant's bytes.
  const storageBucket = await ensureTenantBucketChecked(bucketAdminS3Client, session.organizationId)

  const bytes = Buffer.from(await file.arrayBuffer())
  // The same digest the project corpus records, from the same helper. The
  // Archiv has no folder upload of its own today; the column still describes
  // the bytes on every shelf, so a row here is not the one that has to be
  // explained later.
  const contentHash = contentDigest(bytes)

  // Probe, store, admit — and once more when a concurrent FIRST upload of this
  // name won the shelf: the second run finds the winner and records these bytes
  // as its next version, as the same two drops in sequence would have. See
  // `retryRacedUpload` and `uploadDocument`.
  const { documentId, storageKey } = await retryRacedUpload(async () => {
    const superseded = await findLiveDocumentByFilename(session.organizationId, collectionName, filename)
    const documentId = superseded?.id ?? crypto.randomUUID()
    // A re-upload writes new bytes under a new `v<n>/<write id>/` key, so the
    // version it replaces keeps an object a reader can open (ADR-0054). Version
    // 1 keeps today's key exactly. A re-upload never takes the version-1
    // shortcut: the number is a hint and reads 1 while the winner of a
    // concurrent first upload has not recorded its version yet, which would aim
    // this PUT at the winner's own key. The row's number is allocated under a
    // lock when the version is recorded.
    const baseKey = buildArchivStorageKey(session.organizationId, documentId, filename)
    const storageKey = superseded
      ? versionWriteKey(
          baseKey,
          await nextVersionNumber(documentId, session.organizationId),
          newVersionWriteId(),
        )
      : baseKey

    await s3Client.send(
      new PutObjectCommand({
        Bucket: storageBucket,
        Key: storageKey,
        Body: bytes,
        ContentType: file.type || 'application/octet-stream',
      }),
    )

    // Same hard ceiling as the project path, and the same compensating delete on
    // refusal (ADR-0042). The Archiv shares the tenant's bytes, so it must not be
    // a way around the limit — including under concurrency, which is what the
    // pre-check above cannot cover.
    if (superseded) {
      await admitReplacementOrDiscard(storageBucket, storageKey, session.organizationId, documentId, {
        storageKey,
        storageBucket,
        fileSize: file.size,
        contentType: file.type || null,
        contentHash,
        folderId: null,
        createdBy: session.userId,
      })
      // Nothing is discarded: the previous bytes are the previous VERSION's now
      // (ADR-0054) and its row still names them. They go with the document.
    } else {
      // A `LiveFilenameTakenError` here is the lost first-upload race; the
      // object is already discarded and nothing was charged.
      await admitOrDiscard(storageBucket, storageKey, {
        id: documentId,
        organizationId: session.organizationId,
        projectId: null,
        scope: 'archiv',
        folderId: null,
        createdBy: session.userId,
        filename,
        storageKey,
        storageBucket,
        collectionName,
        fileSize: file.size,
        contentType: file.type || null,
        contentHash,
        status: 'uploaded',
      })
    }
    return { documentId, storageKey }
  })

  // The version, through the same transition table every other shelf uses
  // (ADR-0054): born `published` and born approved, because the person who
  // uploaded it is the assertion. With the columns THIS request stored.
  await recordUploadedVersionOrDiscard(session, documentId, request, {
    storageKey,
    storageBucket,
    contentType: file.type || null,
    fileSize: file.size,
    contentHash,
  })

  // Same dispatcher as every other shelf: the STEP source of an IFC is never
  // embedded, so an uploaded model is parsed and its digest is what reaches the
  // org-wide Archiv collection.
  const { jobId, status } = await dispatchDocument({
    organizationId: session.organizationId,
    projectId: null,
    documentId,
    filename,
    storageKey,
    storageBucket,
    collectionName,
  })

  // Data-provenance event: who brought which file into the org Archiv.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'archiv.document.uploaded',
    targetType: 'document',
    targetId: documentId,
    metadata: { filename: filename.slice(0, 200), fileSize: file.size, collectionName },
    request,
  })
  await auditScreeningOverride(
    session,
    { documentId, projectId: null, filename, overridden: nameGate.overridden },
    request,
  )

  return { documentId, jobId, status, filename }
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
