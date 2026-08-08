/**
 * Archiv service — business logic for the org-wide document Archiv.
 *
 * The Archiv is a hierarchical add-on on top of the existing documents domain:
 * an Archiv document is a `documents` row with `scope = 'archiv'`, `projectId`
 * NULL, and `collectionName = archiv_<orgId>`. That lets this service REUSE the
 * document pipeline wholesale — the SeaweedFS upload, the `/v1/ingest` dispatch
 * (`dispatchIngest`), the server-side upload allow-list (`assertUploadTypeAllowed`),
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
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import {
  s3Client,
  bucketAdminS3Client,
  buildArchivStorageKey,
  buildThumbnailStorageKey,
} from '@/lib/s3'
import { ensureTenantBucket, resolveDocumentBucket } from '@/lib/storage/bucket'
import { canManageArchiv } from '@/lib/authz/organizations'
import { recordAuditEvent } from '@/lib/audit/service'
import { getBackendUrl } from '@/lib/backend-proxy'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { assertFileSizeAllowed, assertUploadTypeAllowed, dispatchIngest, fetchSemanticHits, joinHitsToFiles, type SearchedDocument } from '@/lib/documents/service'
import { assertWithinStorageQuota } from '@/lib/storage/service'
import { reconcileDocumentStatuses, type DocumentMetadata } from '@/lib/documents/reconcile-status'
import type { DocumentListRow } from '@/lib/documents/repository'
import type { AuthorizedSession } from '@/lib/auth/types'
import { archivCollectionName } from './collection'
import {
  deleteArchivDocument as deleteArchivDocumentRow,
  findArchivDocument,
  insertArchivDocument,
  listArchivDocuments as listArchivDocumentRows,
} from './repository'

/** Bound the best-effort backend call that purges an ingested doc's RAG chunks. */
const BACKEND_FETCH_TIMEOUT_MS = 10_000

export interface ArchivListResult {
  documents: Array<Omit<DocumentListRow, 'metadata'> & DocumentMetadata>
  collectionName: string
  /** Whether the caller may upload/delete (drives the read-only vs manage UI). */
  canManage: boolean
}

/**
 * List the org's Archiv (bounded), lazily reconciling in-flight ingestion
 * statuses with the backend and merging its read-only document metadata — the
 * exact same treatment `listDocuments` gives a project's corpus. Any org member
 * may read; the internal `metadata` jsonb never leaves the BFF.
 */
export async function listArchiv(session: AuthorizedSession): Promise<ArchivListResult> {
  const rows = await listArchivDocumentRows(session.organizationId)
  const reconciled = await reconcileDocumentStatuses(rows, session.organizationId)
  return {
    documents: reconciled.map(({ metadata: _metadata, ...row }) => row),
    collectionName: archivCollectionName(session.organizationId),
    canManage: canManageArchiv(session),
  }
}

/**
 * Document-centric semantic search over the org's shared Archiv. Any org member
 * may read (via `listArchiv`); resolves the org's `archiv_<orgId>` collection,
 * runs the deterministic vector search on the backend, and joins the hits to the
 * Archiv's file rows by filename. Fail-open: a backend error/timeout yields
 * `{ hits: [] }`, never a crash.
 */
export async function searchArchivDocuments(
  session: AuthorizedSession,
  query: string,
  topK = 20,
): Promise<{ hits: Array<SearchedDocument<ArchivListResult['documents'][number]>> }> {
  const { documents, collectionName } = await listArchiv(session)
  const hits = await fetchSemanticHits(collectionName, query, topK)
  return { hits: joinHitsToFiles(hits, documents) }
}

export interface UploadArchivDocumentResult {
  documentId: string
  jobId: string | null
  status: 'pending' | 'uploaded' | 'failed'
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
): Promise<UploadArchivDocumentResult> {
  if (!canManageArchiv(session)) throw new ForbiddenError()
  await assertUploadTypeAllowed(session, file.name)
  assertFileSizeAllowed(file.size)
  // Same org ceiling as the project path — the Archiv shares the tenant's
  // bytes, so it must not be a way around the quota (ADR-0042).
  await assertWithinStorageQuota(session.organizationId, file.size)

  const documentId = crypto.randomUUID()
  const collectionName = archivCollectionName(session.organizationId)
  const storageKey = buildArchivStorageKey(session.organizationId, documentId, file.name)

  // Same provisioning step as the project path (ADR-0043): the Archiv shares
  // the tenant's bucket, because it shares the tenant's bytes.
  const storageBucket = await ensureTenantBucket(bucketAdminS3Client, session.organizationId)

  const bytes = Buffer.from(await file.arrayBuffer())
  await s3Client.send(
    new PutObjectCommand({
      Bucket: storageBucket,
      Key: storageKey,
      Body: bytes,
      ContentType: file.type || 'application/octet-stream',
    }),
  )

  await insertArchivDocument({
    id: documentId,
    organizationId: session.organizationId,
    projectId: null,
    scope: 'archiv',
    folderId: null,
    createdBy: session.userId,
    filename: file.name,
    storageKey,
    storageBucket,
    collectionName,
    fileSize: file.size,
    contentType: file.type || null,
    status: 'uploaded',
  })

  const { jobId, status } = await dispatchIngest(
    documentId,
    collectionName,
    storageKey,
    session.organizationId,
    storageBucket,
  )

  // Data-provenance event: who brought which file into the org Archiv.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'archiv.document.uploaded',
    targetType: 'document',
    targetId: documentId,
    metadata: { filename: file.name.slice(0, 200), fileSize: file.size, collectionName },
    request,
  })

  return { documentId, jobId, status, filename: file.name }
}

/**
 * Delete an Archiv document: purge its RAG chunks (best-effort), remove the
 * SeaweedFS object, delete the row, and audit. Requires `org:archiv:manage`.
 */
export async function deleteArchivDocument(
  session: AuthorizedSession,
  documentId: string,
  request: Request,
): Promise<void> {
  if (!canManageArchiv(session)) throw new ForbiddenError()

  const doc = await findArchivDocument(documentId, session.organizationId)
  if (!doc) throw new NotFoundError()

  // Best-effort: remove the ingested chunks so a deleted document stops showing
  // up in retrieval. A backend hiccup must not block the durable SeaweedFS + DB
  // cleanup below, so failures here are swallowed.
  try {
    await fetch(`${getBackendUrl()}/v1/collections/${encodeURIComponent(doc.collectionName)}/documents`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_ids: [doc.filename] }),
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
  } catch {
    // ignore — chunks may linger until the next collection reconcile/purge
  }

  if (doc.storageKey) {
    try {
      const bucket = resolveDocumentBucket(doc.storageBucket)
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: doc.storageKey }))
      // The ingest pipeline writes `_thumb.jpg` beside the object; deleting
      // only the document left it orphaned. Same fix as the project path.
      const thumbKey = buildThumbnailStorageKey(doc.storageKey)
      if (thumbKey) {
        await s3Client
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: thumbKey }))
          .catch(() => undefined)
      }
    } catch {
      // ignore — the object may already be gone; the row delete below is the record of intent
    }
  }

  await deleteArchivDocumentRow(documentId, session.organizationId)

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'archiv.document.deleted',
    targetType: 'document',
    targetId: documentId,
    metadata: { filename: doc.filename.slice(0, 200), collectionName: doc.collectionName },
    request,
  })
}
