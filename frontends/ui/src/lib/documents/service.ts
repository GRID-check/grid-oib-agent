/**
 * Documents service — business logic for the documents domain.
 *
 * Owns authorization (org tenancy in SQL + per-project FGA via
 * `requireProjectAccess`) and orchestration across the repository, MinIO,
 * the Python backend ingest API, status reconciliation, and the audit trail.
 * Route handlers stay thin: they validate input shape and delegate here.
 * Failures are signalled with typed errors from `@/lib/api/errors`.
 */

import 'server-only'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, signingS3Client, bucketName, buildObjectKey } from '@/lib/s3'
import { requireProjectAccess } from '@/lib/authz/projects'
import { recordAuditEvent } from '@/lib/audit/service'
import { getBackendUrl } from '@/lib/backend-proxy'
import { findProjectInOrg } from '@/lib/projects/repository'
import { ApiError, ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'
import { reconcileDocumentStatuses } from './reconcile-status'
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

const presignTtlSeconds = (): number =>
  Number((process.env.S3_PRESIGNED_URL_TTL_SECONDS ?? process.env.MINIO_PRESIGNED_URL_TTL_SECONDS) || 600)

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
 * Load a document (org-scoped in SQL) and enforce per-project access.
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
  await requireProjectAccess(session, doc.projectId, permission)
  return doc
}

/**
 * Dispatch a document to the backend ingest API and persist the outcome. The
 * upload and re-ingest paths share this so the success path (status pending +
 * jobId) and the failure path (status failed + errorMessage) stay identical.
 *
 * Best-effort: the file is already durable in MinIO + Postgres. Three outcomes:
 *   - a job id came back  → status pending  (setDocumentIngestJob)
 *   - dispatch failed     → status failed   (markDocumentIngestFailed)
 *   - ok but no job id    → status left as-is ('uploaded' on first upload)
 */
async function dispatchIngest(
  documentId: string,
  collectionName: string,
  minioKey: string,
): Promise<{ jobId: string | null; status: 'pending' | 'uploaded' | 'failed' }> {
  // The backend fetches the file itself, from inside the Docker network —
  // sign with the internal-endpoint client, not the browser-facing one.
  const presignedUrl = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucketName, Key: minioKey }), {
    expiresIn: presignTtlSeconds(),
  })

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
      }),
    })

    if (ingestRes.ok) {
      const ingestResult = await ingestRes.json()
      ingestJobId = ingestResult.job_id ?? null
    } else {
      ingestFailed = true
    }
  } catch {
    // Dispatch never reached the backend — the document is in MinIO + DB but
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
 * ingestion statuses with the backend. Internal metadata never leaves the BFF.
 */
export async function listDocuments(
  session: AuthorizedSession,
  projectId: string,
): Promise<Omit<DocumentListRow, 'metadata'>[]> {
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

/**
 * Store an uploaded file in MinIO, record it, and hand it to the backend for
 * ingestion. The ingest call is best-effort: the document is already durable
 * in MinIO + Postgres, and status reads reconcile the outcome later.
 */
export async function uploadDocument(
  session: AuthorizedSession,
  input: UploadDocumentInput,
  request: Request,
): Promise<UploadDocumentResult> {
  const { projectId, folderId, file } = input

  await requireProjectAccess(session, projectId, 'project:edit')

  let folderPath: string | null = null
  if (folderId) {
    folderPath = await findFolderPathInProject(folderId, projectId)
    if (folderPath === null) throw new NotFoundError('Folder not found in project')
  }

  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')

  const documentId = crypto.randomUUID()
  const collectionName = project.collectionName
  const minioKey = buildObjectKey(session.organizationId, projectId, documentId, file.name, folderPath)

  const bytes = Buffer.from(await file.arrayBuffer())
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: minioKey,
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
    minioKey,
    collectionName,
    fileSize: file.size,
    contentType: file.type || null,
    status: 'uploaded',
  })

  const { jobId: ingestJobId, status: ingestStatus } = await dispatchIngest(documentId, collectionName, minioKey)

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

export interface CommitUploadedFileInput {
  userId: string
  organizationId: string
  projectId: string
  folderId: string | null
  filename: string
  /** Canonical S3 key the bytes already live at (validated against org/project). */
  objectKey: string
  fileSize: number | null
  contentType: string | null
}

/**
 * Register a file whose bytes already exist in S3 (e.g. written through the
 * mounted-drive gateway) as a real document, and dispatch async ingestion — the
 * SAME lifecycle a web upload runs (`uploadDocument`), minus the byte PUT. This is
 * the convergence seam so a drive upload is not a lifecycle-less orphan: it gets a
 * `documents` row, a collection, and an ingest job into the agent.
 *
 * The caller must already be authorized (`project:edit`); this additionally
 * enforces that `objectKey` lives under the caller's org+project prefix, so a
 * drive cannot register bytes into another tenant's namespace.
 */
export async function commitUploadedFile(
  input: CommitUploadedFileInput,
): Promise<{ documentId: string; status: 'pending' | 'uploaded' | 'failed' }> {
  const requiredPrefix = `org/${input.organizationId}/project/${input.projectId}/`
  if (!input.objectKey.startsWith(requiredPrefix)) {
    throw new NotFoundError()
  }

  const project = await findProjectInOrg(input.projectId, input.organizationId)
  if (!project) throw new NotFoundError('Project not found')

  const documentId = crypto.randomUUID()
  await insertDocument({
    id: documentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    folderId: input.folderId ?? null,
    createdBy: input.userId,
    filename: input.filename,
    minioKey: input.objectKey,
    collectionName: project.collectionName,
    fileSize: input.fileSize,
    contentType: input.contentType,
    status: 'uploaded',
  })

  // Same async ingest the web path uses (best-effort today; a durable
  // document_ingest_queue is the tracked next step — see ENTERPRISE-READINESS.md).
  const { status } = await dispatchIngest(documentId, project.collectionName, input.objectKey)
  return { documentId, status }
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
  if (!doc.minioKey) throw new NotFoundError('File not available')

  const { jobId, status } = await dispatchIngest(doc.id, doc.collectionName, doc.minioKey)
  return { id: doc.id, status, jobId }
}

/** Presign a browser-facing download URL for a document. */
export async function getDocumentDownload(
  session: AuthorizedSession,
  documentId: string,
): Promise<{ downloadUrl: string; filename: string; contentType: string | null; fileSize: number | null }> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.minioKey) throw new NotFoundError('File not available')

  const downloadUrl = await getSignedUrl(
    signingS3Client,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: doc.minioKey,
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
  if (!doc.minioKey) throw new NotFoundError('File not available')

  const contentType = doc.contentType || 'application/octet-stream'
  if (!PREVIEW_CONTENT_TYPES.includes(contentType)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Preview not available for this file type', { contentType })
  }

  const url = await getSignedUrl(
    signingS3Client,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: doc.minioKey,
      ResponseContentDisposition: contentDisposition('inline', doc.filename),
      ResponseContentType: contentType,
    }),
    { expiresIn: 3600 },
  )

  return { url, contentType, filename: doc.filename }
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
  }
}
