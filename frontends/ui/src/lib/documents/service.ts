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
import { s3Client, signingS3Client, bucketName, buildMinioKey } from '@/lib/s3'
import { requireProjectAccess } from '@/lib/authz/projects'
import { recordAuditEvent } from '@/lib/audit/service'
import { getBackendUrl } from '@/lib/backend-proxy'
import { findProjectInOrg } from '@/lib/projects/repository'
import { ApiError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'
import { reconcileDocumentStatuses } from './reconcile-status'
import {
  findDocumentInOrg,
  findFolderPathInProject,
  insertDocument,
  listProjectDocuments,
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

const presignTtlSeconds = (): number => Number(process.env.MINIO_PRESIGNED_URL_TTL_SECONDS || 600)

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
 * Cross-tenant and no-access lookups both surface as 404.
 */
async function getAccessibleDocument(session: AuthorizedSession, documentId: string): Promise<Document> {
  const doc = await findDocumentInOrg(documentId, session.organizationId)
  if (!doc) throw new NotFoundError()
  await requireProjectAccess(session, doc.projectId, 'project:view')
  return doc
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
  status: 'pending' | 'uploaded'
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
  const minioKey = buildMinioKey(session.organizationId, projectId, documentId, file.name, folderPath)

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

  // The backend fetches the file itself, from inside the Docker network —
  // sign with the internal-endpoint client, not the browser-facing one.
  const presignedUrl = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucketName, Key: minioKey }), {
    expiresIn: presignTtlSeconds(),
  })

  let ingestJobId: string | null = null
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
    }
  } catch {
    // Ingestion call is best-effort; document is already in MinIO + DB
  }

  if (ingestJobId) {
    await setDocumentIngestJob(documentId, ingestJobId)
  }

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
    status: ingestJobId ? 'pending' : 'uploaded',
    filename: file.name,
  }
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
