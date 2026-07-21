/**
 * Documents service — business logic for the documents domain.
 *
 * Owns authorization (org tenancy in SQL + per-project FGA via
 * `requireProjectAccess`) and orchestration across the repository, SeaweedFS,
 * the Python backend ingest API, status reconciliation, and the audit trail.
 * Route handlers stay thin: they validate input shape and delegate here.
 * Failures are signalled with typed errors from `@/lib/api/errors`.
 */

import 'server-only'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, signingS3Client, bucketName, buildStorageKey } from '@/lib/s3'
import { requireProjectAccess } from '@/lib/authz/projects'
import { canManageArchiv } from '@/lib/authz/organizations'
import { ForbiddenError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { getBackendUrl } from '@/lib/backend-proxy'
import { findProjectInOrg } from '@/lib/projects/repository'
import { ApiError, BadRequestError, ConflictError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import { ALLOWED_TAGS } from './tag-vocabulary'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { isVlmConfigured } from '@/lib/documents/vlm-capability'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'
import { reconcileDocumentStatuses, type DocumentMetadata } from './reconcile-status'
import {
  findDocumentInOrg,
  findFolderPathInProject,
  insertDocument,
  listProjectDocuments,
  markDocumentIngestFailed,
  setDocumentIngestJob,
  type DocumentListRow,
} from './repository'

const PREVIEW_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',
]

const presignTtlSeconds = (): number => Number(process.env.SEAWEED_PRESIGNED_URL_TTL_SECONDS || 600)

/** Replace the filename segment of a storageKey with `_thumb.jpg`. */
function buildThumbnailStorageKey(storageKey: string): string {
  const idx = storageKey.lastIndexOf('/')
  return idx > 0 ? `${storageKey.slice(0, idx)}/_thumb.jpg` : '_thumb.jpg'
}

/**
 * Bound every server-side call to the Python backend: an unreachable backend
 * container otherwise hangs the BFF request past Cloudflare's ~100s origin
 * timeout (→ 504). Ingest dispatch is best-effort (a timeout is caught and
 * recorded as a failed ingest); the tag edit is user-blocking (a timeout
 * surfaces as an UpstreamError, same as any other transport failure).
 */
const BACKEND_FETCH_TIMEOUT_MS = 10_000

/**
 * Stored on the document when the backend ingest dispatch never yielded a job.
 * Persisted server-side (like backend-produced error messages), so it cannot
 * go through the per-user i18n dictionaries.
 */
export const INGEST_DISPATCH_FAILED_MESSAGE = 'Ingestion could not be started'

/**
 * Filenames are user-controlled and end up in the `Content-Disposition` of
 * presigned URLs — strip header-breaking characters (CR/LF, double quotes),
 * cap the length, and never emit an empty name.
 */
function sanitizeFilename(raw: string): string {
  const cleaned = raw.replace(/[\r\n"]/g, '').trim().slice(0, 255)
  return cleaned || 'download'
}

/** RFC 5987 percent-encoding for the `filename*` parameter. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Build a header-safe Content-Disposition: an ASCII-only `filename` fallback
 * plus the RFC 5987 `filename*` carrying the full UTF-8 name.
 */
function contentDisposition(type: 'attachment' | 'inline', rawFilename: string): string {
  const filename = sanitizeFilename(rawFilename)
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\]/g, '_') || 'download'
  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`
}

/**
 * Load a document (org-scoped in SQL) and enforce access appropriate to its
 * scope, so the SAME item routes (download/preview/status/reingest/tags) serve
 * both project documents and org-wide Archiv documents:
 *
 *   - `project` documents → per-project FGA via `requireProjectAccess`.
 *   - `archiv` documents (org-wide, `projectId` NULL) → any org member may read
 *     (`view`); mutations (`edit`) require `org:archiv:manage`.
 *
 * Cross-tenant and no-access lookups both surface as 404. Reads default to
 * `project:view`; mutating actions (e.g. re-ingestion) pass `project:edit`.
 */
async function getAccessibleDocument(
  session: AuthorizedSession,
  documentId: string,
  permission: 'project:view' | 'project:edit' = 'project:view',
): Promise<Document> {
  const doc = await findDocumentInOrg(documentId, session.organizationId)
  if (!doc) throw new NotFoundError()

  if (doc.scope === 'archiv' || doc.projectId === null) {
    // The Archiv is org-scoped: findDocumentInOrg already confirmed the row
    // belongs to the caller's org (so any member may read it). Only mutations
    // need the manage permission.
    if (permission === 'project:edit' && !canManageArchiv(session)) {
      throw new ForbiddenError()
    }
    return doc
  }

  await requireProjectAccess(session, doc.projectId, permission)
  return doc
}

/**
 * Dispatch a document to the backend ingest API and persist the outcome. The
 * upload and re-ingest paths share this so the success path (status pending +
 * jobId) and the failure path (status failed + errorMessage) stay identical.
 *
 * Best-effort: the file is already durable in SeaweedFS + Postgres. Three outcomes:
 *   - a job id came back  → status pending  (setDocumentIngestJob)
 *   - dispatch failed     → status failed   (markDocumentIngestFailed)
 *   - ok but no job id    → status left as-is ('uploaded' on first upload)
 */
export async function dispatchIngest(
  documentId: string,
  collectionName: string,
  storageKey: string,
): Promise<{ jobId: string | null; status: 'pending' | 'uploaded' | 'failed' }> {
  // The backend fetches the file itself, from inside the Docker network —
  // sign with the internal-endpoint client, not the browser-facing one.
  const presignedUrl = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucketName, Key: storageKey }), {
    expiresIn: presignTtlSeconds(),
  })

  // Generate presigned upload URL for a 200px JPEG thumbnail
  const thumbnailUploadKey = buildThumbnailStorageKey(storageKey)
  const thumbnailUploadUrl = await getSignedUrl(
    signingS3Client,
    new PutObjectCommand({
      Bucket: bucketName,
      Key: thumbnailUploadKey,
      ContentType: 'image/jpeg',
    }),
    { expiresIn: 3600 },
  )

  let ingestJobId: string | null = null
  let ingestFailed = false
  try {
    const ingestRes = await fetch(`${getBackendUrl()}/v1/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_ref: presignedUrl,
        collection: collectionName,
        document_id: documentId,
        thumbnail_upload_url: thumbnailUploadUrl,
      }),
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })

    if (ingestRes.ok) {
      const ingestResult = await ingestRes.json()
      ingestJobId = ingestResult.job_id ?? null
    } else {
      ingestFailed = true
    }
  } catch {
    // Dispatch never reached the backend — the document is in SeaweedFS + DB but
    // has no ingest job, so it can never be reconciled to a truthful status.
    ingestFailed = true
  }

  if (ingestJobId) {
    await setDocumentIngestJob(documentId, ingestJobId)
    return { jobId: ingestJobId, status: 'pending' }
  }
  if (ingestFailed) {
    // Persist 'failed' so status reads stop rendering an unsearchable document
    // as a green "Ready" (it would otherwise sit at 'uploaded' forever).
    await markDocumentIngestFailed(documentId, INGEST_DISPATCH_FAILED_MESSAGE)
    return { jobId: null, status: 'failed' }
  }
  return { jobId: null, status: 'uploaded' }
}

/**
 * List a project's documents (bounded), lazily reconciling in-flight
 * ingestion statuses with the backend and merging the backend's read-only
 * document metadata (summary, page/chunk counts, content types). The internal
 * `metadata` jsonb column (which carries `ingestJobId`) never leaves the BFF;
 * the curated metadata fields ride alongside as top-level properties.
 */
export async function listDocuments(
  session: AuthorizedSession,
  projectId: string,
): Promise<Array<Omit<DocumentListRow, 'metadata'> & DocumentMetadata>> {
  await requireProjectAccess(session, projectId, 'project:view')

  const rows = await listProjectDocuments(projectId, session.organizationId)

  // Pending rows are lazily reconciled with the backend's ingestion state;
  // without this they would stay 'pending' forever (no completion callback).
  const reconciled = await reconcileDocumentStatuses(rows)

  return reconciled.map(({ metadata: _metadata, ...row }) => row)
}

export interface UploadDocumentInput {
  projectId: string
  folderId: string | null
  file: File
}

export interface UploadDocumentResult {
  documentId: string
  jobId: string | null
  status: 'pending' | 'uploaded' | 'failed'
  filename: string
}

/** Lowercased extension including the leading dot, or '' when there is none. */
function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx).toLowerCase() : ''
}

/**
 * Server-side upload allow-list. The client already filters by accepted type,
 * but nothing enforced it on the server until now — so any type could be
 * POSTed directly. This mirrors the same env-driven accepted-types config the
 * client uses (closing that gap for ALL types), and gates image types by
 * availability = the `image-upload` flag AND the derived VLM capability:
 * images are in the allow-list only when the session's org has the flag AND a
 * vision model resolves on the backend. The capability comes from the same
 * TTL-cached probe (`isVlmConfigured`) that layout.tsx uses, so this allow-list
 * and the client's accepted-types list are ONE truth. Fail-closed: an
 * unconfirmable capability excludes images (never a silent-failure upload).
 */
export async function assertUploadTypeAllowed(session: AuthorizedSession, filename: string): Promise<void> {
  const imageUploadEnabled = isFeatureEnabled(session, FEATURE_FLAGS.imageUpload)
  const vlmAvailable = await isVlmConfigured()
  const { acceptedTypes } = getFileUploadConfigFromEnv(process.env, { imageUploadEnabled, vlmAvailable })
  const allowed = acceptedTypes
    .split(',')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
  const ext = fileExtension(filename)
  if (!ext || !allowed.includes(ext)) {
    throw new BadRequestError(`File type "${ext || 'unknown'}" is not permitted`, {
      extension: ext || null,
      accepted: allowed,
    })
  }
}

/**
 * Store an uploaded file in SeaweedFS, record it, and hand it to the backend for
 * ingestion. The ingest call is best-effort: the document is already durable
 * in SeaweedFS + Postgres, and status reads reconcile the outcome later.
 */
export async function uploadDocument(
  session: AuthorizedSession,
  input: UploadDocumentInput,
  request: Request,
): Promise<UploadDocumentResult> {
  const { projectId, folderId, file } = input

  await requireProjectAccess(session, projectId, 'project:edit')
  await assertUploadTypeAllowed(session, file.name)

  let folderPath: string | null = null
  if (folderId) {
    folderPath = await findFolderPathInProject(folderId, projectId)
    if (folderPath === null) throw new NotFoundError('Folder not found in project')
  }

  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')

  const documentId = crypto.randomUUID()
  const collectionName = project.collectionName
  const storageKey = buildStorageKey(session.organizationId, projectId, documentId, file.name, folderPath)

  const bytes = Buffer.from(await file.arrayBuffer())
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: storageKey,
      Body: bytes,
      ContentType: file.type || 'application/octet-stream',
    }),
  )

  await insertDocument({
    id: documentId,
    organizationId: session.organizationId,
    projectId,
    folderId: folderId ?? null,
    createdBy: session.userId,
    filename: file.name,
    storageKey,
    collectionName,
    fileSize: file.size,
    contentType: file.type || null,
    status: 'uploaded',
  })

  const { jobId: ingestJobId, status: ingestStatus } = await dispatchIngest(documentId, collectionName, storageKey)

  // Data-provenance event: who brought which file into which project.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.uploaded',
    targetType: 'document',
    targetId: documentId,
    // Filename is user-controlled — cap it before it reaches the trail.
    metadata: { projectId, filename: file.name.slice(0, 200), fileSize: file.size },
    request,
  })

  return {
    documentId,
    jobId: ingestJobId,
    status: ingestStatus,
    filename: file.name,
  }
}

export interface ReingestDocumentResult {
  id: string
  status: 'pending' | 'uploaded' | 'failed'
  jobId: string | null
}

/**
 * Re-dispatch a previously-failed document to the backend ingest API. Only
 * documents in status `failed` are eligible — re-ingesting a pending/ready one
 * would be a no-op at best and a duplicate job at worst, so it 409s. Reuses the
 * shared dispatch helper, so the success/failure persistence matches upload.
 */
export async function reingestDocument(
  session: AuthorizedSession,
  documentId: string,
): Promise<ReingestDocumentResult> {
  const doc = await getAccessibleDocument(session, documentId, 'project:edit')

  if (doc.status !== 'failed') {
    throw new ConflictError('Only failed documents can be re-ingested', { status: doc.status })
  }
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const { jobId, status } = await dispatchIngest(doc.id, doc.collectionName, doc.storageKey)
  return { id: doc.id, status, jobId }
}

/**
 * Replace a document's controlled tags. Requires `project:edit`. The document
 * row maps to the backend's `(collectionName, filename)` summary key; the edit
 * is proxied to the Python tag endpoint, which is the authority on the
 * vocabulary. Tags are also validated here against the mirrored `ALLOWED_TAGS`
 * so an obviously-bad request fails fast (400) without a backend round-trip;
 * an empty list clears the tags. A missing summary row surfaces as 404.
 */
export async function updateDocumentTags(
  session: AuthorizedSession,
  documentId: string,
  tags: string[],
): Promise<{ id: string; tags: string[] }> {
  const doc = await getAccessibleDocument(session, documentId, 'project:edit')

  const offending = tags.filter((tag) => !ALLOWED_TAGS.has(tag))
  if (offending.length > 0) {
    throw new BadRequestError('Tags outside the controlled vocabulary are not allowed', {
      invalidTags: offending,
    })
  }

  let res: Response
  try {
    res = await fetch(
      `${getBackendUrl()}/v1/collections/${encodeURIComponent(doc.collectionName)}/documents/${encodeURIComponent(
        doc.filename,
      )}/tags`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
        signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
      },
    )
  } catch {
    // Includes a TimeoutError abort — treat a hung backend like any other
    // transport failure rather than letting the request hang.
    throw new UpstreamError('Could not reach the document service')
  }

  if (res.status === 404) throw new NotFoundError()
  if (res.status === 400) {
    throw new BadRequestError('Tags outside the controlled vocabulary are not allowed')
  }
  if (!res.ok) throw new UpstreamError('The document service rejected the tag update')

  const body = await res.json().catch(() => ({}))
  return { id: doc.id, tags: Array.isArray(body.tags) ? body.tags : tags }
}

/** Presign a browser-facing download URL for a document. */
export async function getDocumentDownload(
  session: AuthorizedSession,
  documentId: string,
): Promise<{ downloadUrl: string; filename: string; contentType: string | null; fileSize: number | null }> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const downloadUrl = await getSignedUrl(
    signingS3Client,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: doc.storageKey,
      ResponseContentDisposition: contentDisposition('attachment', doc.filename),
    }),
    { expiresIn: presignTtlSeconds() },
  )

  return {
    downloadUrl,
    filename: doc.filename,
    contentType: doc.contentType,
    fileSize: doc.fileSize,
  }
}

/**
 * Presign a browser-facing inline preview URL. Non-previewable content types
 * are rejected with a 415.
 */
export async function getDocumentPreview(
  session: AuthorizedSession,
  documentId: string,
): Promise<{ url: string; contentType: string; filename: string }> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const contentType = doc.contentType || 'application/octet-stream'
  if (!PREVIEW_CONTENT_TYPES.includes(contentType)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Preview not available for this file type', { contentType })
  }

  const url = await getSignedUrl(
    signingS3Client,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: doc.storageKey,
      ResponseContentDisposition: contentDisposition('inline', doc.filename),
      ResponseContentType: contentType,
    }),
    { expiresIn: 3600 },
  )

  return { url, contentType, filename: doc.filename }
}

/** Presign a browser-facing thumbnail URL (null when no thumbnail exists). */
export async function getDocumentThumbnail(
  session: AuthorizedSession,
  documentId: string,
): Promise<{ url: string | null }> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) return { url: null }

  const thumbnailKey = buildThumbnailStorageKey(doc.storageKey)

  try {
    const url = await getSignedUrl(
      signingS3Client,
      new GetObjectCommand({
        Bucket: bucketName,
        Key: thumbnailKey,
        ResponseContentType: 'image/jpeg',
      }),
      { expiresIn: 3600 },
    )
    return { url }
  } catch {
    return { url: null }
  }
}

/** Read one document's status, lazily reconciled with the backend. */
export async function getDocumentStatus(session: AuthorizedSession, documentId: string) {
  const doc = await getAccessibleDocument(session, documentId)

  // Pending rows are lazily reconciled with the backend's ingestion state;
  // without this they would stay 'pending' forever (no completion callback).
  const [reconciled] = await reconcileDocumentStatuses([doc])

  return {
    id: reconciled.id,
    status: reconciled.status,
    filename: reconciled.filename,
    fileSize: reconciled.fileSize,
    contentType: reconciled.contentType,
    collectionName: reconciled.collectionName,
    errorMessage: reconciled.errorMessage,
    createdAt: reconciled.createdAt,
    updatedAt: reconciled.updatedAt,
    // Read-only document metadata merged from the backend collection listing.
    summary: reconciled.summary,
    pageCount: reconciled.pageCount,
    chunkCount: reconciled.chunkCount,
    contentTypes: reconciled.contentTypes,
    tags: reconciled.tags,
  }
}
