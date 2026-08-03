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
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, signingS3Client, bucketName, buildStorageKey } from '@/lib/s3'
import { requireProjectAccess } from '@/lib/authz/projects'
import { canManageArchiv } from '@/lib/authz/organizations'
import { ForbiddenError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { getBackendUrl } from '@/lib/backend-proxy'
import { buildGridRequestContextWireHeaders } from '@/lib/request-context'
import { findProjectInOrg } from '@/lib/projects/repository'
import { ApiError, BadRequestError, ConflictError, NotFoundError, UpstreamError } from '@/lib/api/errors'
import { ALLOWED_TAGS } from './tag-vocabulary'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { buildDocumentImageUrl, verifyDocumentImageUrl } from '@/lib/images/signed-image-url'
import { isVlmConfigured } from '@/lib/documents/vlm-capability'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'
import { reconcileDocumentStatuses, type DocumentMetadata } from './reconcile-status'
import {
  deleteProjectDocument,
  findDocumentInOrg,
  findFolderPathInProject,
  findStorageKeyByCollectionAndFilename,
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

/**
 * Content types the signed image route hands to the Next optimizer.
 *
 * Deliberately narrower than {@link PREVIEW_CONTENT_TYPES}. SVG is excluded
 * because the optimizer hard-fails on it (400) unless `dangerouslyAllowSVG` is
 * on, which we will not enable — it would let an uploaded SVG carry script into
 * a same-origin response. BMP and TIFF are excluded because sharp's support is
 * patchier than the browsers' and a decode failure is a broken image, not a
 * slow one. Everything excluded here still previews; it just renders straight
 * from the object store as it does today.
 */
const OPTIMIZABLE_IMAGE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
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
 *     (read); writes require `org:archiv:manage`.
 *
 * Cross-tenant and no-access lookups both surface as 404. The `intent` maps to
 * `project:view` for reads and `project:documents:write` (accepting the legacy
 * `project:edit` umbrella) for writes — ADR-0038.
 */
async function getAccessibleDocument(
  session: AuthorizedSession,
  documentId: string,
  intent: 'read' | 'write' = 'read',
): Promise<Document> {
  const doc = await findDocumentInOrg(documentId, session.organizationId)
  if (!doc) throw new NotFoundError()

  if (doc.scope === 'archiv' || doc.projectId === null) {
    // The Archiv is org-scoped: findDocumentInOrg already confirmed the row
    // belongs to the caller's org (so any member may read it). Only mutations
    // need the manage permission.
    if (intent === 'write' && !canManageArchiv(session)) {
      throw new ForbiddenError()
    }
    return doc
  }

  await requireProjectAccess(
    session,
    doc.projectId,
    intent === 'write' ? ['project:documents:write', 'project:edit'] : 'project:view',
  )
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
  organizationId: string,
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
      // Forward the org id so the backend resolves the org's BYOK vision
      // credential + runtime model override for VLM captioning during ingestion.
      headers: { 'Content-Type': 'application/json', 'x-grid-organization-id': organizationId },
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

/**
 * A single hit from the backend's document-centric semantic search
 * (`POST /v1/collections/{c}/search`). One hit per file, best snippet, sorted
 * by score descending. Deterministic vector search — no LLM.
 */
export interface BackendSearchHit {
  file_name: string
  score: number
  snippet: string
  page_number: number | null
  collection: string
}

/**
 * A document row joined with its semantic-search match evidence — the existing
 * list row (name, status, metadata) plus WHY it matched: the best snippet, the
 * page it came from, and the 0..1 relevance score. Returned reordered by score.
 */
export type SearchedDocument<T> = T & {
  snippet: string
  page: number | null
  score: number
}

/**
 * Passages retrieved per requested file. `_aggregate_hits` on the backend keeps
 * one hit per file (its best-scoring chunk), so the chunk budget (`top_k`) must
 * comfortably exceed `top_k_files` or it silently caps how many distinct files
 * can surface. A few passages per file absorbs the common case where a file's
 * best chunk isn't its first-ranked one without over-fetching. The backend
 * bounds `top_k` at 100 (`DocumentSearchRequest`), so the derived budget is
 * clamped to that ceiling — the invariant `top_k >= top_k_files` still holds for
 * every `top_k_files` in the allowed 1..100 range.
 */
const SEARCH_PASSAGES_PER_FILE = 3
const SEARCH_MAX_PASSAGES = 100

/** Derive the passage budget from the requested file count (see the constants above). */
export function deriveSearchTopK(topKFiles: number): number {
  return Math.min(SEARCH_MAX_PASSAGES, Math.max(1, topKFiles) * SEARCH_PASSAGES_PER_FILE)
}

/** Bounded, fail-open POST to the backend's document-centric search endpoint.
 *
 * Deterministic vector search. Any non-OK response, malformed body, timeout, or
 * transport failure yields `[]` (never throws) — the caller surfaces this to the
 * UI as "no semantic results" rather than a crash.
 *
 * The `top_k` passage budget is DERIVED from `topKFiles` (`deriveSearchTopK`) so
 * a large `top_k_files` is never starved by a fixed chunk cap.
 *
 * Forwards the signed `X-Grid-Request-Context` envelope scoped to exactly this
 * collection (defense-in-depth, PB-SYNTH-4): the callers here have already
 * authorized the caller to read `collectionName` (project FGA / org membership),
 * and the backend route rejects any `collection_name` not present in the signed
 * scope — closing the cross-tenant read hole if the backend is reachable by
 * anything other than this BFF. Signed with `GRID_INTERNAL_API_TOKEN` via the
 * shared envelope builder (never hand-rolled), so the raw, forgeable
 * `X-Grid-Collection-Scope` header alone can't be used to widen scope.
 */
export async function fetchSemanticHits(
  collectionName: string,
  query: string,
  topKFiles: number,
): Promise<BackendSearchHit[]> {
  const scopeHeaders = buildGridRequestContextWireHeaders(
    { collectionScope: [collectionName] },
    process.env.GRID_INTERNAL_API_TOKEN,
  )
  try {
    const res = await fetch(`${getBackendUrl()}/v1/collections/${encodeURIComponent(collectionName)}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...scopeHeaders },
      body: JSON.stringify({ query, top_k: deriveSearchTopK(topKFiles), top_k_files: topKFiles }),
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return []
    const body = await res.json().catch(() => ({}))
    return Array.isArray(body?.hits) ? (body.hits as BackendSearchHit[]) : []
  } catch {
    // Includes a TimeoutError abort — a hung/unreachable backend fails open to
    // an empty result set, exactly like any other transport failure.
    return []
  }
}

/**
 * Join backend hits to the existing file rows BY FILENAME (`hit.file_name` ===
 * `file.filename`), returning the matched rows reordered by score (hit order,
 * which the backend guarantees is score-descending), each augmented with its
 * snippet, page, and score. Hits with no matching row are dropped. When a
 * filename collides across rows the most-recent row (latest `createdAt`) wins,
 * so a re-uploaded document resolves to its current entry.
 */
export function joinHitsToFiles<T extends { filename: string; createdAt: Date | string }>(
  hits: BackendSearchHit[],
  files: T[],
): Array<SearchedDocument<T>> {
  const byName = new Map<string, T>()
  for (const file of files) {
    const existing = byName.get(file.filename)
    if (!existing || new Date(file.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      byName.set(file.filename, file)
    }
  }

  const matched: Array<SearchedDocument<T>> = []
  for (const hit of hits) {
    const file = byName.get(hit.file_name)
    if (!file) continue
    matched.push({ ...file, snippet: hit.snippet, page: hit.page_number ?? null, score: hit.score })
  }
  return matched
}

/**
 * Document-centric semantic search over a project's corpus. Enforces
 * `project:view` (via `listDocuments`), resolves the project's RAG collection,
 * runs the deterministic vector search on the backend, and joins the hits to the
 * project's own file rows by filename. Fail-open: a backend error/timeout yields
 * `{ hits: [] }`, never a crash.
 */
export async function searchProjectDocuments(
  session: AuthorizedSession,
  projectId: string,
  query: string,
  topK = 20,
): Promise<{ hits: Array<SearchedDocument<Awaited<ReturnType<typeof listDocuments>>[number]>> }> {
  // Authorization (project:view) + the canonical file rows come from the same
  // path the normal list uses, so a semantic result is always a real, visible
  // document with its live status/metadata.
  const files = await listDocuments(session, projectId)

  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')

  const hits = await fetchSemanticHits(project.collectionName, query, topK)
  return { hits: joinHitsToFiles(hits, files) }
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
 * Server-side file-size enforcement: guards the S3 upload against oversized
 * payloads even when the client allows them (the client check is a UX courtesy).
 * Reuses the env-based config that also drives the client-side max, so both
 * layers are governed by one source of truth.
 */
export function assertFileSizeAllowed(sizeBytes: number): void {
  const { maxFileSize } = getFileUploadConfigFromEnv(process.env)
  if (sizeBytes > maxFileSize) {
    const maxSizeMB = maxFileSize / (1024 * 1024)
    throw new BadRequestError(`File exceeds the maximum allowed size of ${maxSizeMB} MB`, {
      fileSize: sizeBytes,
      maxSizeBytes: maxFileSize,
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

  await requireProjectAccess(session, projectId, ['project:documents:write', 'project:edit'])
  await assertUploadTypeAllowed(session, file.name)
  assertFileSizeAllowed(file.size)

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

  const { jobId: ingestJobId, status: ingestStatus } = await dispatchIngest(
    documentId,
    collectionName,
    storageKey,
    session.organizationId,
  )

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
  const doc = await getAccessibleDocument(session, documentId, 'write')

  if (doc.status !== 'failed') {
    throw new ConflictError('Only failed documents can be re-ingested', { status: doc.status })
  }
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const { jobId, status } = await dispatchIngest(doc.id, doc.collectionName, doc.storageKey, session.organizationId)
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
  const doc = await getAccessibleDocument(session, documentId, 'write')

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

/**
 * Delete a project document: purge its RAG chunks (best-effort), remove the
 * SeaweedFS object, delete the row, and audit. Requires `project:edit` on the
 * owning project — the same permission the upload path checks. Mirrors
 * {@link import('@/lib/archiv/service').deleteArchivDocument}, differing only in
 * scope: per-project FGA instead of org-level `org:archiv:manage`.
 *
 * Org-wide Archiv documents (NULL `projectId`) are NOT deletable here — they go
 * through the org-scoped `/api/archiv/documents/[id]` route — so an Archiv id
 * surfaces as a 404 rather than being force-fit through project FGA.
 */
export async function deleteDocument(
  session: AuthorizedSession,
  documentId: string,
  request: Request,
): Promise<void> {
  const doc = await findDocumentInOrg(documentId, session.organizationId)
  if (!doc || doc.projectId === null) throw new NotFoundError()

  await requireProjectAccess(session, doc.projectId, ['project:documents:write', 'project:edit'])

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
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: doc.storageKey }))
    } catch {
      // ignore — the object may already be gone; the row delete below is the record of intent
    }
  }

  await deleteProjectDocument(documentId, session.organizationId, doc.projectId)

  // Data-provenance event: who removed which file from which project.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.deleted',
    targetType: 'document',
    // Filename is user-controlled — cap it before it reaches the trail.
    metadata: { projectId: doc.projectId, filename: doc.filename.slice(0, 200), collectionName: doc.collectionName },
    request,
  })
}

export interface DocumentVisualDetail {
  page: number
  contentType: string
  drawingType: string
  scale: string
  text: string
}

/**
 * Per-page VLM descriptions of a document's visual chunks (drawings / images /
 * charts) — the "detailed information" the one-line summary is distilled from.
 * Requires `project:view`. Read-only and fail-soft: any backend hiccup or an
 * unsupported backend yields an empty list rather than an error, since this is
 * a secondary, on-demand view.
 */
export async function getDocumentVisualDetails(
  session: AuthorizedSession,
  documentId: string,
): Promise<{ id: string; details: DocumentVisualDetail[] }> {
  const doc = await getAccessibleDocument(session, documentId, 'read')

  let res: Response
  try {
    res = await fetch(
      `${getBackendUrl()}/v1/collections/${encodeURIComponent(doc.collectionName)}/documents/${encodeURIComponent(
        doc.filename,
      )}/visual-details`,
      { signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS) },
    )
  } catch {
    return { id: doc.id, details: [] }
  }

  if (!res.ok) return { id: doc.id, details: [] }

  const body = await res.json().catch(() => ({}))
  const raw = Array.isArray(body.details) ? body.details : []
  const details: DocumentVisualDetail[] = raw.map((d: Record<string, unknown>) => ({
    page: typeof d.page === 'number' ? d.page : 0,
    contentType: typeof d.content_type === 'string' ? d.content_type : 'drawing',
    drawingType: typeof d.drawing_type === 'string' ? d.drawing_type : '',
    scale: typeof d.scale === 'string' ? d.scale : '',
    text: typeof d.text === 'string' ? d.text : '',
  }))
  return { id: doc.id, details }
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
): Promise<{ url: string; contentType: string; filename: string; imageUrl: string | null }> {
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

  // A same-origin, signature-authorized path for the raster image formats the
  // optimizer can actually process — this is what lets `next/image` resize a
  // full-size upload down to the box it is rendered in. Null for PDFs, SVGs and
  // the exotic formats above, whose callers fall back to `url` unoptimized.
  const imageUrl = OPTIMIZABLE_IMAGE_CONTENT_TYPES.includes(contentType)
    ? buildDocumentImageUrl(session.organizationId, documentId, 'original')
    : null

  return { url, contentType, filename: doc.filename, imageUrl }
}

/**
 * Browser-facing thumbnail URL (null when no thumbnail exists).
 *
 * Prefers the signed same-origin route so the card's 124px well gets an
 * optimizer-resized image, and falls back to a presigned object-store URL when
 * signing is unavailable. The ingest pipeline already writes a 200px JPEG here,
 * so the win is a format change (WebP/AVIF) rather than a resize — small, but it
 * keeps every document image on one path instead of leaving this one special.
 */
export async function getDocumentThumbnail(
  session: AuthorizedSession,
  documentId: string,
): Promise<{ url: string | null }> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) return { url: null }

  const signedUrl = buildDocumentImageUrl(session.organizationId, documentId, 'thumb')
  if (signedUrl) return { url: signedUrl }

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

/**
 * Stream a document image for a signed capability URL — the only document route
 * that serves bytes without a session, because the Next image optimizer's
 * internal fetch cannot carry one (see `@/lib/images/signed-image-url`).
 *
 * The signature is the authorization. It was minted by `getDocumentPreview` /
 * `getDocumentThumbnail` AFTER `getAccessibleDocument` ran the real
 * `project:view` check, and it is bound to the org, the document and the
 * variant, so it cannot be walked onto another tenant's document or onto the
 * full-size original when it was issued for a thumbnail. The org id is taken
 * from the signed claims rather than the caller, so the row lookup stays
 * tenant-scoped exactly as the session path is.
 */
export async function streamDocumentImage(
  documentId: string,
  params: URLSearchParams,
): Promise<Response> {
  const verified = verifyDocumentImageUrl(documentId, params)
  if (!verified.ok) {
    if (verified.reason === 'disabled') {
      throw new ApiError(503, 'IMAGE_URLS_DISABLED', 'Signed image URLs are not configured')
    }
    // Expired, malformed and forged are one answer to the caller on purpose:
    // distinguishing them tells an attacker which half of the token to work on.
    throw new ForbiddenError('Invalid or expired image URL')
  }

  const { organizationId, variant } = verified.claims
  const doc = await findDocumentInOrg(documentId, organizationId)
  if (!doc?.storageKey) throw new NotFoundError()

  const contentType = variant === 'thumb' ? 'image/jpeg' : doc.contentType || ''
  // Belt and braces over the signing-side check: this route serves images and
  // nothing else, so a token minted against a row that later changed type
  // cannot turn into a download channel for an arbitrary upload.
  if (!contentType.startsWith('image/')) throw new NotFoundError()

  const key = variant === 'thumb' ? buildThumbnailStorageKey(doc.storageKey) : doc.storageKey

  let body
  try {
    const object = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))
    body = object.Body
  } catch {
    // A document with no generated thumbnail lands here; the card reads the 404
    // as "no thumbnail" and shows its warm placeholder.
    throw new NotFoundError('Image not available')
  }
  if (!body) throw new NotFoundError('Image not available')

  return new Response(body.transformToWebStream(), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      // Private: the bytes are tenant data, and the optimizer keeps its own
      // server-side cache regardless. Bounded by the signature's own lifetime.
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
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

/**
 * Resolve a document's SeaweedFS storage key from the `(collectionName,
 * filename)` pair the Python backend carries — the read side of the internal
 * document-file lookup (`/api/internal/document-file`).
 *
 * There is deliberately no session / FGA here: the caller is the backend over
 * the service-token-guarded internal network, and the collection name is the
 * tenancy boundary (`proj_<uuid>` / `archiv_<orgId>` are unguessable). When the
 * backend derives an `organizationId` from an `archiv_` collection prefix, it
 * is forwarded to narrow the row lookup to that org; otherwise the lookup is
 * collection-only. The backend uses the key to fetch the raw bytes from
 * SeaweedFS for the `view_knowledge_image` tool (ADR-0039), so this is
 * read-only metadata — it never returns the bytes themselves.
 */
export async function findDocumentStorageKey(
  collectionName: string,
  filename: string,
  organizationId?: string,
): Promise<{ storageKey: string; contentType: string | null } | null> {
  return findStorageKeyByCollectionAndFilename(collectionName, filename, organizationId)
}
