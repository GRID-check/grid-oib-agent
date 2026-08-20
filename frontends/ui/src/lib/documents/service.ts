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
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  s3Client,
  signingS3Client,
  bucketAdminS3Client,
  buildStorageKey,
  buildThumbnailStorageKey,
} from '@/lib/s3'
import { ensureTenantBucketChecked, resolveDocumentBucket } from '@/lib/storage/bucket'
import { requireProjectAccess } from '@/lib/authz/projects'
import { canManageArchiv } from '@/lib/authz/organizations'
import { requireResourceAccess } from '@/lib/sharing/access'
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
import { assertWithinStorageQuota } from '@/lib/storage/service'
import { admitOrDiscard } from '@/lib/storage/admission'
import { FEATURE_FLAGS, isCollaborationEnabled, isFeatureEnabled, isIfcModelsEnabled } from '@/lib/authz/feature-flags'
import { listResourceAssignments } from '@/lib/assignments/service'
import { deleteAssignmentsForResource } from '@/lib/assignments/repository'
import { purgeResourceCollaboration } from '@/lib/collaboration/cleanup'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document, DocumentAuthor } from '@/lib/db/schema'
import { reconcileDocumentStatuses, type DocumentMetadata } from './reconcile-status'
import {
  deleteProjectDocument,
  findDocumentInOrg,
  findFolderPathInProject,
  findStorageKeyByCollectionAndFilename,
  listProjectDocuments,
  markDocumentIngestFailed,
  markDocumentProcessing,
  setDocumentDisplayName,
  setDocumentIngestJob,
  type DocumentListRow,
} from './repository'
import { documentDisplayName, validateDocumentName } from './display-name'
import { deleteBimDerivedObjects, runBimExtraction } from '@/lib/bim/service'
import { isIfcFilename } from '@/lib/bim/types'

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
 * Load a document (org-scoped in SQL) and enforce the access its OWN shelf
 * calls for, so the SAME item routes (download/preview/status/reingest/tags)
 * serve all three shelves:
 *
 *   - `project` → per-project FGA via `requireProjectAccess`.
 *   - `archiv`  → org-wide: any member reads, writes need `org:archiv:manage`.
 *   - `session` → as private as the chat it hangs off: `viewer` to read,
 *     `collaborator` to write, resolved on the conversation (ADR-0032).
 *
 * ## Why this switches on `scope` and not on `projectId`
 *
 * It used to read `doc.scope === 'archiv' || doc.projectId === null`, which was
 * correct while a null project could only mean the Archiv. A session document
 * also has a null project (ADR-0047 Phase 2), so that disjunction would have
 * handed every private chat attachment to the Archiv branch — where any member
 * of the organization may read it. The upload is private; the download would
 * not have been. A `switch` over the scope union is exhaustive, so a fourth
 * shelf cannot fall through to somebody else's rule: it fails to compile.
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

  switch (doc.scope) {
    case 'archiv': {
      // Org-scoped: findDocumentInOrg already confirmed the row belongs to the
      // caller's org (so any member may read it). Only mutations need the
      // manage permission.
      if (intent === 'write' && !canManageArchiv(session)) throw new ForbiddenError()
      return doc
    }
    case 'session': {
      // A row that contradicts `documents_session_requires_conversation`
      // (migration 0049) is not something to guess about — it is unattributable,
      // so it is not found.
      if (!doc.conversationId) throw new NotFoundError()
      await requireResourceAccess(
        session,
        'conversation',
        doc.conversationId,
        intent === 'write' ? 'collaborator' : 'viewer',
      )
      return doc
    }
    case 'project': {
      // A `project` row with no project is a corrupt row, not an org-wide one.
      // The old disjunction quietly re-read it as an Archiv document and handed
      // it to every member; there is nothing to authorize against, so it is not
      // found.
      if (doc.projectId === null) throw new NotFoundError()
      await requireProjectAccess(
        session,
        doc.projectId,
        intent === 'write' ? ['project:documents:write', 'project:edit'] : 'project:view',
      )
      return doc
    }
    default: {
      // Two jobs. At COMPILE time the `never` annotation is the exhaustiveness
      // check ADR-0047 decision 3 asks for: add a shelf to `DocumentScope` and
      // this line stops type-checking until it has a rule here. At RUN time it
      // catches what the type cannot — `scope` is a plain `text` column, so a
      // row can hold a value no version of this code knows. There is no
      // authorization rule to apply to such a row, and defaulting to another
      // shelf's is how a private document becomes an org-wide one.
      const unhandledScope: never = doc.scope
      void unhandledScope
      throw new NotFoundError()
    }
  }
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
  /**
   * The bucket the object was written to (ADR-0043). Passed rather than
   * derived: the caller has just written the object and knows exactly where it
   * went, and the two presigned URLs below must both name that same bucket —
   * the download the backend reads from, and the thumbnail slot it writes back
   * to. Defaults to the shared bucket so a caller predating per-org buckets
   * keeps its old behaviour.
   */
  storageBucket: string | null = null,
): Promise<{ jobId: string | null; status: 'pending' | 'uploaded' | 'failed' }> {
  const bucket = resolveDocumentBucket(storageBucket)
  // The backend fetches the file itself, from inside the Docker network —
  // sign with the internal-endpoint client, not the browser-facing one.
  const presignedUrl = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucket, Key: storageKey }), {
    expiresIn: presignTtlSeconds(),
  })

  // Presigned upload slot for the 200px JPEG thumbnail the ingest pipeline
  // generates. Null for a key with no directory segment: there is nowhere to
  // put a sibling, and signing a bucket-root `_thumb.jpg` would hand out a
  // write capability to a shared path rather than to this document's own.
  const thumbnailUploadKey = buildThumbnailStorageKey(storageKey)
  const thumbnailUploadUrl = thumbnailUploadKey
    ? await getSignedUrl(
        signingS3Client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: thumbnailUploadKey,
          ContentType: 'image/jpeg',
        }),
        { expiresIn: 3600 },
      )
    : null

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
    await setDocumentIngestJob(documentId, organizationId, ingestJobId)
    return { jobId: ingestJobId, status: 'pending' }
  }
  if (ingestFailed) {
    // Persist 'failed' so status reads stop rendering an unsearchable document
    // as a green "Ready" (it would otherwise sit at 'uploaded' forever).
    await markDocumentIngestFailed(documentId, organizationId, INGEST_DISPATCH_FAILED_MESSAGE)
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
  /**
   * Narrowing options. `authoredBy` is pushed down to the query rather than
   * filtered here: the „Von Piloti" chip asks for the small minority of rows a
   * machine wrote, migration 0063 gave that predicate its own partial index,
   * and filtering after the fact would read the whole project's corpus — plus
   * reconcile and assignment-hydrate every row of it — to return a handful.
   */
  options: { authoredBy?: DocumentAuthor } = {},
): Promise<Array<Omit<DocumentListRow, 'metadata'> & DocumentMetadata>> {
  await requireProjectAccess(session, projectId, 'project:view')

  const rows = await listProjectDocuments(
    projectId,
    session.organizationId,
    // `undefined` takes the repository's own default rather than restating it
    // here, where a second copy of the cap could drift from the real one.
    undefined,
    options.authoredBy,
  )

  // Pending rows are lazily reconciled with the backend's ingestion state;
  // without this they would stay 'pending' forever (no completion callback).
  const reconciled = await reconcileDocumentStatuses(rows, session.organizationId)

  const listed = reconciled.map(({ metadata: _metadata, ...row }) => row)

  if (!isCollaborationEnabled(session) || listed.length === 0) {
    return listed.map((row) => ({ ...row, assignees: [] }))
  }

  const grouped = await listResourceAssignments(
    session,
    'document',
    listed.map((row) => row.id),
  )
  return listed.map((row) => ({ ...row, assignees: grouped[row.id] ?? [] }))
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
 *
 * ## Machine-authored rows are not candidates, and the collision rule is why
 *
 * A hit comes from the retrieval index, and nothing machine-authored is ever
 * indexed — so every hit describes a document a person supplied. This join is
 * what turns that hit back into a row, and it keys on FILENAME, which is not a
 * safe identity across authorship.
 *
 * `generatedFilename` builds `slug(title)-YYYY-MM-DD.ext` from a title the
 * MODEL wrote — a report's own H1, a diagram card's `title`. So a filed report
 * whose title slugs to the stem of a real Gutachten, on the same day, collides.
 * The tie-break then decides it, and it decides it the wrong way by
 * construction: the agent row was written after the corpus it was written from,
 * so it is always the most recent. The reader would get a search result labelled
 * „Von Piloti erstellt" carrying a snippet and a page number lifted from
 * somebody's actual Gutachten.
 *
 * No chunk was created for the agent row and no retrieval invariant was broken —
 * the leak is in the join, not in the index, which is why the dispatch-site
 * guard and the storage-key allow-list do not reach it. This is the third path
 * by which a machine-authored row can reach a reader as evidence, and it is
 * closed the same way as the other two: by asking the row, not by trusting the
 * name.
 */
export function joinHitsToFiles<
  T extends { filename: string; createdAt: Date | string; authoredBy?: string },
>(hits: BackendSearchHit[], files: T[]): Array<SearchedDocument<T>> {
  const byName = new Map<string, T>()
  for (const file of files) {
    // `undefined` is a row from a caller that does not carry the column (the
    // Archiv join); those corpora have no machine-authored rows, and defaulting
    // them OUT would silently empty their search.
    if (file.authoredBy !== undefined && file.authoredBy !== 'user') continue
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
  /**
   * `processing` is the IFC path: extraction runs in this process and there is
   * no backend job to report yet, but the document is genuinely being worked on
   * — reporting `uploaded` would render a green "Ready" for a model that cannot
   * be opened.
   */
  status: 'pending' | 'uploaded' | 'failed' | 'processing'
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
  const ifcUploadEnabled = isIfcModelsEnabled(session)
  const vlmAvailable = await isVlmConfigured()
  const { acceptedTypes } = getFileUploadConfigFromEnv(process.env, {
    imageUploadEnabled,
    vlmAvailable,
    ifcUploadEnabled,
  })
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
export function assertFileSizeAllowed(sizeBytes: number, filename?: string): void {
  // `ifcUploadEnabled: true` only to READ the IFC ceiling — whether a `.ifc`
  // may be uploaded at all is `assertUploadTypeAllowed`'s job, and it has
  // already run by the time a size is being checked. Without the filename the
  // caller gets the general limit, which is the safe direction.
  const { maxFileSize, maxIfcFileSize } = getFileUploadConfigFromEnv(process.env, {
    ifcUploadEnabled: true,
  })
  const ceiling = filename && isIfcFilename(filename) ? maxIfcFileSize : maxFileSize
  if (sizeBytes > ceiling) {
    const maxSizeMB = Math.round(ceiling / (1024 * 1024))
    throw new BadRequestError(`File exceeds the maximum allowed size of ${maxSizeMB} MB`, {
      fileSize: sizeBytes,
      maxSizeBytes: ceiling,
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
  assertFileSizeAllowed(file.size, file.name)
  // Org-wide ceiling, checked after the per-file one so the caller gets the
  // more specific complaint first, and BEFORE any bytes reach SeaweedFS so a
  // refusal leaves no orphan object behind (ADR-0042).
  await assertWithinStorageQuota(session.organizationId, file.size)

  let folderPath: string | null = null
  if (folderId) {
    folderPath = await findFolderPathInProject(folderId, projectId, session.organizationId)
    if (folderPath === null) throw new NotFoundError('Folder not found in project')
  }

  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')

  const documentId = crypto.randomUUID()
  const collectionName = project.collectionName
  const storageKey = buildStorageKey(session.organizationId, projectId, documentId, file.name, folderPath)

  // Create the organization's bucket if this is its first upload (ADR-0043).
  // A no-op — not even a round trip — when per-org buckets are off. Done before
  // the PUT so a provisioning failure leaves nothing behind, same reasoning as
  // the quota check above.
  const storageBucket = await ensureTenantBucketChecked(bucketAdminS3Client, session.organizationId)

  const bytes = Buffer.from(await file.arrayBuffer())
  await s3Client.send(
    new PutObjectCommand({
      Bucket: storageBucket,
      Key: storageKey,
      Body: bytes,
      ContentType: file.type || 'application/octet-stream',
    }),
  )

  // The quota's HARD ceiling: the usage is re-read inside the same transaction
  // that inserts the row, under a per-organization lock, so concurrent uploads
  // cannot jointly cross the limit the way the pre-check above allows (ADR-0042).
  //
  // The object is already written, so a refusal has to take it back — the row was
  // not inserted, so nothing else will ever reference those bytes and leaving
  // them would be an orphan that only a bucket-wide sweep could find.
  await admitOrDiscard(storageBucket, storageKey, {
    id: documentId,
    organizationId: session.organizationId,
    projectId,
    folderId: folderId ?? null,
    createdBy: session.userId,
    filename: file.name,
    storageKey,
    // Recorded even when it IS the shared bucket, so only rows predating
    // migration 0033 rely on the NULL-means-shared convention.
    storageBucket,
    collectionName,
    fileSize: file.size,
    contentType: file.type || null,
    status: 'uploaded',
  })

  const { jobId: ingestJobId, status: ingestStatus } = await dispatchDocument({
    organizationId: session.organizationId,
    projectId,
    documentId,
    filename: file.name,
    storageKey,
    storageBucket,
    collectionName,
  })

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

export interface BeginModelExtractionInput {
  organizationId: string
  projectId: string | null
  documentId: string
  filename: string
  storageKey: string
  storageBucket: string | null
  collectionName: string
}

/**
 * What a stored object needs before anything can be started for it. Identical
 * to {@link BeginModelExtractionInput} because the IFC branch is the one that
 * needs more: `dispatchIngest` uses a strict subset of these fields.
 */
export type DispatchDocumentInput = BeginModelExtractionInput

export interface DispatchDocumentResult {
  jobId: string | null
  /** `processing` is the IFC path — see {@link beginModelExtraction}. */
  status: 'pending' | 'uploaded' | 'failed' | 'processing'
}

/**
 * The ONE place that decides what happens to a freshly-stored object: an IFC
 * model is parsed, everything else is ingested.
 *
 * An IFC model must NOT go to the ingestor as-is — its STEP source would be
 * embedded as unreadable noise. It is parsed here instead, and the Markdown
 * digest that parse produces is what gets ingested (see `@/lib/bim/service`).
 *
 * That branch used to be written out at each call site — the project upload,
 * the project re-ingest, and the org-wide Archiv upload — which made "does this
 * caller remember that a model is not a document?" a question every new caller
 * had to be asked. Session uploads are the third shelf (ADR-0047 Phase 2) and
 * would have been the fourth copy. There is one copy now, so a caller cannot
 * forget the branch: it cannot see it.
 */
/**
 * Thrown when something tries to index a document a machine wrote.
 *
 * Named and exported so a caller can tell this refusal apart from a backend
 * failure: one is a bug in the caller, the other is an outage.
 */
export class AgentAuthoredDocumentNotIndexableError extends Error {
  constructor(readonly documentId: string) {
    super(`document ${documentId} was written by a machine and must not be indexed`)
    this.name = 'AgentAuthoredDocumentNotIndexableError'
  }
}

export async function dispatchDocument(input: DispatchDocumentInput): Promise<DispatchDocumentResult> {
  /**
   * A document a machine wrote never reaches the retrieval index — checked
   * HERE, at the one place every ingestion path funnels through, and checked by
   * READING THE ROW rather than by trusting the caller.
   *
   * The invariant used to live in `generated.ts`, which only proved that the
   * FILING path does not ingest. That is a claim about one function; the claim
   * the design actually makes is about the document. `reindexProject` — behind
   * the „Projekt neu indizieren" button in Project Settings — enumerated every
   * document in the project and re-dispatched it, and an agent-authored row
   * passed its guard: `stored` is neither `pending` nor `processing`, and the
   * row carries a real storage key and the project's own collection. One click
   * put Piloti's own report into the corpus it retrieves from, whereupon the
   * status became `completed` and the entire not-citable UI — which derives
   * from `status`, not from `authoredBy` — went green.
   *
   * Reading the row costs one primary-key select on an operation that is about
   * to make an HTTP call to the backend, and it buys an invariant no caller can
   * forget and no caller can lie about. Passing authorship in the input would
   * be cheaper and weaker: the next caller would simply be able to get it
   * wrong, which is exactly what happened.
   */
  const row = await findDocumentInOrg(input.documentId, input.organizationId)
  if (row && row.authoredBy !== 'user') {
    throw new AgentAuthoredDocumentNotIndexableError(input.documentId)
  }

  if (isIfcFilename(input.filename)) {
    return beginModelExtraction(input)
  }
  return dispatchIngest(
    input.documentId,
    input.collectionName,
    input.storageKey,
    input.organizationId,
    input.storageBucket,
  )
}

/**
 * Kick off IFC extraction for a stored `.ifc` object and return the same shape
 * `dispatchIngest` does, so the upload path stays one expression.
 *
 * Extraction is DETACHED, not awaited. A 60 MB model takes tens of seconds to
 * parse, and the caller is an HTTP request that has already stored the bytes —
 * blocking it would trade a durable upload for a gateway timeout. The document
 * is marked `processing` first, so the row never renders as a green "Ready"
 * for a model that cannot be opened yet, and every terminal outcome writes the
 * row again:
 *
 *   - parse succeeded → the digest is dispatched, which sets `pending` + job id
 *   - parse failed    → `failed` with the reason, and a `bim_models` row that
 *                       records the same thing for the model surfaces
 *
 * The tradeoff this accepts: a process restart mid-parse leaves the document at
 * `processing` and the model at `extracting`. That is visible in both places
 * and recoverable through the ordinary re-ingest action, which is a better
 * failure than a lost upload.
 */
export async function beginModelExtraction(
  input: BeginModelExtractionInput,
): Promise<{ jobId: string | null; status: 'pending' | 'uploaded' | 'failed' | 'processing' }> {
  await markDocumentProcessing(input.documentId, input.organizationId)

  void runBimExtraction({
    organizationId: input.organizationId,
    projectId: input.projectId,
    documentId: input.documentId,
    filename: input.filename,
    storageKey: input.storageKey,
    storageBucket: input.storageBucket,
    dispatchDigest: (digestStorageKey) =>
      dispatchIngest(
        input.documentId,
        input.collectionName,
        digestStorageKey,
        input.organizationId,
        input.storageBucket,
      ),
  })
    .then(async (outcome) => {
      if (outcome.status === 'failed') {
        await markDocumentIngestFailed(
          input.documentId,
          input.organizationId,
          outcome.error ?? 'IFC extraction failed',
        )
      }
    })
    .catch(async () => {
      // runBimExtraction is written not to throw; this is the belt to its
      // braces, so an unexpected failure still leaves a truthful row rather
      // than a document stuck at 'processing' forever.
      await markDocumentIngestFailed(
        input.documentId,
        input.organizationId,
        'IFC extraction failed',
      ).catch(() => undefined)
    })

  return { jobId: null, status: 'processing' }
}

export interface ReingestDocumentResult {
  id: string
  status: 'pending' | 'uploaded' | 'failed' | 'processing'
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

  // The bucket the object is ACTUALLY in — `doc.storageBucket`, not the bucket
  // a new upload would go to. Both presigned URLs the dispatch mints name it:
  // the download the backend reads from, and the thumbnail slot it writes back
  // to. Omitting it defaulted both to the shared bucket, so retrying a
  // per-organization document presigned a GET for an object that is not there
  // (the retry can never succeed) and a PUT into the shared bucket for a
  // thumbnail every read path then looks for in the tenant bucket.
  // A failed IFC document is retried by re-EXTRACTING it, not by re-dispatching
  // its bytes: the raw model was never what ingestion consumed, so handing the
  // STEP file to the ingestor here would "succeed" into a collection full of
  // geometry noise — a green status on a model still unopenable. That is
  // `dispatchDocument`'s single branch, shared with every upload path.
  const { jobId, status } = await dispatchDocument({
    organizationId: session.organizationId,
    projectId: doc.projectId,
    documentId: doc.id,
    filename: doc.filename,
    storageKey: doc.storageKey,
    storageBucket: doc.storageBucket,
    collectionName: doc.collectionName,
  })
  return { id: doc.id, status, jobId }
}

export interface ReindexProjectResult {
  projectId: string
  /** Documents whose old chunks were removed and which are ingesting again. */
  queued: number
  /** Rows with no stored object, or still mid-flight — nothing to rebuild from. */
  skipped: number
  /** Display names whose chunk delete failed, so they were deliberately NOT re-dispatched. */
  failed: string[]
}

/** Chunk-delete + re-dispatch runs this many documents at a time. */
const REINDEX_CONCURRENCY = 4

/**
 * Rebuild every document's chunks in one project.
 *
 * Distinct from `reingestDocument`, which is a RETRY: that one refuses anything
 * whose status is not `failed`, because re-dispatching a healthy document is a
 * different and more dangerous operation. This is that operation, and the danger
 * is duplication — the ingest endpoint downloads and indexes, it does not replace,
 * so dispatching a document that already has chunks leaves BOTH sets in the
 * collection, both retrievable and both rendering as a valid citation.
 *
 * So the delete is a PRECONDITION here, not a courtesy. `deleteDocument` swallows
 * a failed chunk-delete on purpose (the durable row and object cleanup matter more,
 * and leftover chunks get swept by the next reconcile). The same failure here means
 * the opposite: dispatching after it would create the duplicate this whole function
 * exists to avoid. A document whose delete fails is reported and left alone.
 *
 * Reach for this after a change to how chunks are BUILT rather than to what they are
 * built from — a chunker change alters no file, so nothing in the ordinary upload
 * path would notice.
 */
export async function reindexProject(
  session: AuthorizedSession,
  projectId: string,
): Promise<ReindexProjectResult> {
  await requireProjectAccess(session, projectId, 'project:documents:write')

  // `'user'` explicitly, not "everything": a machine-authored document must not
  // be indexed (see `dispatchDocument`), and reaching the dispatcher's refusal
  // would report a project-wide reindex as partially FAILED for rows that were
  // never eligible. The dispatcher is the invariant; this is the caller not
  // asking a question it already knows the answer to.
  const rows = await listProjectDocuments(projectId, session.organizationId, undefined, 'user')
  const result: ReindexProjectResult = { projectId, queued: 0, skipped: 0, failed: [] }

  const redispatch = async (row: DocumentListRow): Promise<void> => {
    // Re-resolved rather than trusted from the list: this is the same read the
    // single-document path uses, it carries the storage key and bucket the list
    // row does not, and it re-checks access per document.
    const doc = await getAccessibleDocument(session, row.id, 'write')
    if (!doc.storageKey || doc.status === 'pending' || doc.status === 'processing') {
      result.skipped += 1
      return
    }

    // The bucket the object is ACTUALLY in — see `reingestDocument` for why
    // defaulting this breaks per-organization documents in two directions.
    const response = await fetch(
      `${getBackendUrl()}/v1/collections/${encodeURIComponent(doc.collectionName)}/documents`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_ids: [doc.filename] }),
        signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
      },
    )
    if (!response.ok) {
      throw new Error(`chunk delete returned ${response.status}`)
    }

    await dispatchDocument({
      organizationId: session.organizationId,
      projectId: doc.projectId,
      documentId: doc.id,
      filename: doc.filename,
      storageKey: doc.storageKey,
      storageBucket: doc.storageBucket,
      collectionName: doc.collectionName,
    })
    result.queued += 1
  }

  // Bounded rather than unbounded: a project with hundreds of documents would
  // otherwise open that many backend connections at once and time the request out.
  let next = 0
  const workers = Array.from({ length: Math.min(REINDEX_CONCURRENCY, rows.length) }, async () => {
    while (next < rows.length) {
      const row = rows[next++]
      try {
        await redispatch(row)
      } catch {
        // One document's failure must not abandon the rest of the project.
        result.failed.push(documentDisplayName(row))
      }
    }
  })
  await Promise.all(workers)

  return result
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
 * Rename a document — the label, never the file.
 *
 * Scope-aware like every other item operation here: `getAccessibleDocument`
 * applies per-project FGA to a project document and `org:archiv:manage` to an
 * Archiv one, so both corpora rename through this one function and one route.
 *
 * ## What actually changes
 *
 * `display_name` in the BFF row, and `display_title` on the backend's metadata
 * row for the same document. Those are the two places a user-facing name is
 * read from — the file lists and preview here, the citation chips there — and
 * they are written together so a renamed document does not answer to two
 * different names depending on which surface you are looking at.
 *
 * `filename` is untouched. It is the join key to the stored object and to every
 * chunk in the retrieval index (see migration 0048), so renaming it would
 * detach the document from its own content. That is also why this needs no
 * re-ingestion: nothing about the indexed document changed.
 *
 * The backend PATCH is BEST-EFFORT, and the ordering says which side wins. The
 * durable rename is the row here; a backend that is down, slow, or has no
 * metadata row for the document (nothing was ever summarized — a failed
 * ingestion, or a model, which has no summary row at all) must not stop a
 * person from correcting a file name. The consequence is bounded and visible:
 * the citation chip keeps the old title until the next rename.
 *
 * Passing `null` clears the rename and restores the file's own name.
 */
export async function renameDocument(
  session: AuthorizedSession,
  documentId: string,
  requestedName: string | null,
  request: Request,
): Promise<{ id: string; filename: string; displayName: string | null }> {
  const doc = await getAccessibleDocument(session, documentId, 'write')

  let displayName: string | null = null
  if (requestedName !== null) {
    const validated = validateDocumentName(requestedName)
    if (!validated.ok) {
      throw new BadRequestError('The document name is not usable', { reason: validated.reason })
    }
    // A rename back to the file's own name is a CLEAR, not a stored duplicate.
    // Otherwise the column would hold a value identical to `filename` and the
    // "has this been renamed" question — which the UI asks to decide whether to
    // offer "restore original name" — would answer yes for a document nobody
    // renamed.
    displayName = validated.value === doc.filename ? null : validated.value
  }

  await setDocumentDisplayName(documentId, session.organizationId, displayName)

  // Mirror the name onto the backend's metadata row so citation chips follow
  // the rename immediately, with no re-ingest (the retrieval layer prefers a
  // stored `display_title` over the derived filename default). Best-effort by
  // design — see the note above.
  try {
    await fetch(
      `${getBackendUrl()}/v1/collections/${encodeURIComponent(doc.collectionName)}/documents/${encodeURIComponent(
        doc.filename,
      )}/display-title`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_title: displayName }),
        signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
      },
    )
  } catch {
    // ignore — the durable rename is the row above; the chip catches up on the
    // next rename or the next re-ingestion.
  }

  // Data-provenance event: who called which file what. Both names are
  // user-controlled, so both are capped before they reach the trail.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: doc.scope === 'archiv' || doc.projectId === null ? 'archiv.document.renamed' : 'document.renamed',
    targetType: 'document',
    targetId: documentId,
    metadata: {
      filename: doc.filename.slice(0, 200),
      previousName: documentDisplayName(doc).slice(0, 200),
      displayName: (displayName ?? doc.filename).slice(0, 200),
      collectionName: doc.collectionName,
    },
    request,
  })

  return { id: documentId, filename: doc.filename, displayName }
}

/**
 * Delete a project document: purge its RAG chunks (best-effort), remove the
 * SeaweedFS object, delete the row, and audit. Requires `project:edit` on the
 * owning project — the same permission the upload path checks. Mirrors
 * {@link import('@/lib/archiv/service').deleteArchivDocument}, differing only in
 * scope: per-project FGA instead of org-level `org:archiv:manage`.
 *
 * Only `project` documents are deletable here. An Archiv id goes through the
 * org-scoped `/api/archiv/documents/[id]` route and a session attachment
 * through `/api/session/documents/[id]`, each with its own authorization — so
 * either surfaces as a 404 rather than being force-fit through project FGA.
 * The scope is asked for by name: "has no project" used to mean "is an Archiv
 * document" and stopped meaning that when session documents became rows.
 */
export async function deleteDocument(
  session: AuthorizedSession,
  documentId: string,
  request: Request,
): Promise<void> {
  const doc = await findDocumentInOrg(documentId, session.organizationId)
  if (!doc || doc.scope !== 'project' || doc.projectId === null) throw new NotFoundError()

  await requireProjectAccess(session, doc.projectId, ['project:documents:write', 'project:edit'])

  await Promise.all([
    purgeResourceCollaboration('document', documentId).catch(() => undefined),
    deleteAssignmentsForResource(session.organizationId, 'document', documentId).catch(() => undefined),
  ])

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
      // The ingest pipeline writes `_thumb.jpg` as a SIBLING of the object, in
      // the same `doc/<id>/` directory. Deleting only the document left it
      // behind: invisible to the UI, invisible to the quota ledger (which
      // counts rows, not bytes), and reachable by anyone who could presign the
      // key. The project-level purge swept it up eventually; a single-document
      // delete never did.
      const thumbKey = buildThumbnailStorageKey(doc.storageKey)
      if (thumbKey) {
        await s3Client
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: thumbKey }))
          .catch(() => undefined)
      }
      // The IFC pipeline writes its digest and index under a `_bim/`
      // subdirectory of the same document folder. Those are nested, not
      // siblings, so the exact-key deletes above never reach them — and the
      // digest is the object the RAG index points at.
      await deleteBimDerivedObjects(doc.storageKey, doc.storageBucket).catch(() => undefined)
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
      Bucket: resolveDocumentBucket(doc.storageBucket),
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
      Bucket: resolveDocumentBucket(doc.storageBucket),
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
 * Stream a stored PDF's bytes from THIS origin, under the same authorization
 * `getAccessibleDocument` applies everywhere else — `project:view` for a project
 * document, org membership for an org-wide Archiv document.
 *
 * The presigned URL `getDocumentPreview` mints points at the object store's own
 * domain, and that is fine for anything the browser NAVIGATES to — a new tab, a
 * download, an iframe. It is not fine for anything the browser FETCHES: the
 * in-app PDF viewer reads the file with XHR to build a text layer, which makes
 * the request cross-origin and subject to CORS, and the S3 gateway this deploys
 * against (SeaweedFS, `deploy/compose/docker-compose.coolify.yaml`) publishes no
 * CORS policy at all. Every project upload and every org-Archiv document would
 * therefore fail to load in the viewer and silently drop to the fallback frame —
 * losing the cited-passage highlight on exactly the documents users uploaded
 * themselves, while the base corpus (already same-origin) kept it.
 *
 * So stored PDFs get the same shape the corpus route has. The presigned URL is
 * not replaced: it still serves the "open in new tab" link and the image
 * branch, where a navigation is what happens and an expiring URL is the point.
 *
 * PDF ONLY, and narrower than {@link PREVIEW_CONTENT_TYPES} on purpose. That
 * list admits `image/svg+xml`, and an SVG is a script carrier: served `inline`
 * from THIS origin it executes in the app's origin with the user's session,
 * which is stored XSS. `frame-ancestors` does not prevent script execution in a
 * top-level document. The same hazard is already spelled out for the image
 * optimizer above — this route must not be the hole that reintroduces it.
 * Images have no reason to come through here anyway: nothing fetches their
 * bytes to parse, so every caller keeps them on the presigned URL.
 */
export async function streamDocumentFile(
  session: AuthorizedSession,
  documentId: string,
): Promise<Response> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const contentType = doc.contentType || 'application/octet-stream'
  if (contentType !== 'application/pdf') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only PDF documents stream from this route', {
      contentType,
    })
  }

  let body
  try {
    const object = await s3Client.send(
      new GetObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: doc.storageKey,
      }),
    )
    body = object.Body
  } catch {
    throw new NotFoundError('File not available')
  }
  if (!body) throw new NotFoundError('File not available')

  // ASCII-safe filename for the header; this route only ever displays inline.
  const asciiName = doc.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_')
  return new Response(body.transformToWebStream(), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${asciiName}"`,
      // Private: these bytes are tenant data.
      'Cache-Control': 'private, max-age=300',
      // The viewer's fallback renders this stream in a same-origin iframe, and
      // the global next.config rule stamps X-Frame-Options: DENY on every
      // route. Override it here, with a matching CSP directive for modern
      // browsers — the same pairing `streamKnowledgeBaseDocument` carries, and
      // next.config carries a route-scoped override to match.
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'",
    },
  })
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

  const thumbnailKey = buildThumbnailStorageKey(doc.storageKey)
  if (!thumbnailKey) return { url: null }

  // The signed same-origin URL is only useful if the JPEG actually exists.
  // Returning it blindly sent Next's image optimizer to a 404 / empty body
  // ("isn't a valid image … received null") for every file that is citable
  // but has no thumbnail yet (#366, #395).
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: thumbnailKey,
      }),
    )
  } catch {
    return { url: null }
  }

  const signedUrl = buildDocumentImageUrl(session.organizationId, documentId, 'thumb')
  if (signedUrl) return { url: signedUrl }

  try {
    const url = await getSignedUrl(
      signingS3Client,
      new GetObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
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
  if (!key) throw new NotFoundError('Image not available')

  let body
  try {
    const object = await s3Client.send(
      new GetObjectCommand({ Bucket: resolveDocumentBucket(doc.storageBucket), Key: key }),
    )
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
  const [reconciled] = await reconcileDocumentStatuses([doc], session.organizationId)

  return {
    id: reconciled.id,
    status: reconciled.status,
    filename: reconciled.filename,
    // The label, next to the identity. Every other surface renders a renamed
    // document through `documentDisplayName`; this payload omitted the column,
    // so the one caller that reads `displayName` here always fell back to the
    // raw filename and a renamed file was named two different ways in one view.
    displayName: reconciled.displayName,
    // The shelf, straight off the row. The composer's "Asking about <file>"
    // bar re-reads it after a reload, where the client no longer holds one —
    // the DB column is the authority, so nothing has to infer a shelf from a
    // collection-id prefix (ADR-0047 decision 3).
    scope: reconciled.scope,
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
): Promise<{ storageKey: string; storageBucket: string | null; contentType: string | null } | null> {
  return findStorageKeyByCollectionAndFilename(collectionName, filename, organizationId)
}
