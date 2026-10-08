/**
 * Documents service — business logic for the documents domain.
 *
 * Owns authorization (org tenancy in SQL + per-project FGA via
 * `requireProjectAccess`) and orchestration across the repository, SeaweedFS,
 * the Python backend ingest API, status reconciliation, and the audit trail.
 * Route handlers stay thin: they validate input shape and delegate here.
 * Failures are signalled with typed errors from `@/lib/api/errors`.
 */

import { ingestScreeningFor } from '@/lib/upload-screening/service'
import 'server-only'
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  s3Client,
  signingS3Client,
  presignForBackend,
  buildImageStorageKey,
  buildThumbnailStorageKey,
} from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { requireProjectAccess } from '@/lib/authz/projects'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { ForbiddenError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { getBackendUrl } from '@/lib/backend-proxy'
import { buildGridRequestContextWireHeaders } from '@/lib/request-context'
import { findProjectInOrg } from '@/lib/projects/repository'
import {
  ApiError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  UpstreamError,
} from '@/lib/api/errors'
import { ALLOWED_TAGS } from './tag-vocabulary'
import { documentStatusFacts } from './document-status'
import { IN_FLIGHT_DOCUMENT_STATUSES } from './document-status'
import { INGEST_ALREADY_DONE, INGEST_NOT_ELIGIBLE, INGEST_RUNNING } from './reingest-codes'
import { normalizeDrawingStructured, type DrawingStructured } from './drawing-structured'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { buildDocumentImageUrl, verifyDocumentImageUrl } from '@/lib/images/signed-image-url'
import { isVlmConfigured } from '@/lib/documents/vlm-capability'
import {
  FEATURE_FLAGS,
  isFeatureEnabled,
  isIfcModelsEnabled,
} from '@/lib/authz/feature-flags'
import { deleteAssignmentsForResource } from '@/lib/assignments/repository'
import { purgeResourceCollaboration } from '@/lib/collaboration/cleanup'
import { assertNoActiveHold } from '@/lib/compliance/holds'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document, DocumentAuthor } from '@/lib/db/schema'
import { reconcileDocumentStatuses, describeBackendIngestState } from './reconcile-status'
import { toListedDocuments, toListedPage, type ListedDocument } from './shelf-listing'
import { projectShelf } from './shelf'
import { uploadToShelf, type UploadDocumentResult } from './shelf-upload'
import { resolveDocumentFolderPath } from './folder-path'
import {
  collectionFileRef,
  collectionFileUrl,
  purgeIngestedChunks,
} from './collection-file-ref'
import {
  deleteProjectDocument,
  documentExistsInCollection,
  findDocumentInOrg,
  findStorageKeyByCollectionAndFilename,
  findStorageKeyByIdAndCollection,
  listProjectDocumentPage,
  findProjectDocumentsByFilenames,
  findProjectDocumentsByNames,
  type DocumentNameMatchRow,
  markDocumentIngestFailed,
  markDocumentProcessing,
  setDocumentDisplayName,
  setDocumentBackgroundJob,
  setDocumentIngestJob,
  setDocumentReconciledStatus,
  listFailedDocumentPageInOrg,
  type DocumentListRow,
} from './repository'
import { documentDisplayName, validateDocumentName } from './display-name'
import { decodeTextBytes } from '@/lib/text/decode-text'
import type { DocumentListCursor } from './list-cursor'
import { withTenant } from '@/lib/db/tenant-context'
import { runBimExtraction } from '@/lib/bim/service'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { findOpenJobId } from '@/lib/jobs-queue/repository'
import {
  BFF_JOB_PRIORITY,
  emptyCounts,
  FAILED_NAMES_KEPT,
  requesterOf,
  type BffJobPriority,
  type BimExtractPayload,
  type JobAttempt,
  type JobCounts,
  type JobSliceResult,
  type OfficeRenditionPayload,
  type ReindexProjectPayload,
  type ReingestFailedPayload,
} from '@/lib/jobs-queue/types'
import { getAccessibleDocument } from './access'
import { findOpenVersion, listDocumentVersionSummaries } from './version-repository'
import { eraseDocumentObjectsOrKeepRow } from './object-cleanup'
import { isIfcFilename } from '@/lib/bim/types'
import {
  INLINE_PREVIEW_CONTENT_TYPES,
  TEXT_PREVIEW_CONTENT_TYPES as SHARED_TEXT_PREVIEW_CONTENT_TYPES,
  isOfficeRenditionSource,
} from './preview-types'
import {
  RenditionFailedError,
  RenditionUnavailableError,
  ensureRendition,
  extractsFromRendition,
  isRenditionEnabled,
} from './rendition'

const PREVIEW_CONTENT_TYPES: readonly string[] = INLINE_PREVIEW_CONTENT_TYPES

/**
 * Text-shaped documents the reader gets as TEXT rather than as a presigned URL.
 *
 * These are accepted at upload (`shared/config/file-upload.ts`) and had no
 * viewer at all: a `.md` a colleague uploaded showed the same grey "download it
 * to read it" mock as a `.dwg` we genuinely cannot render. They are separate
 * from {@link PREVIEW_CONTENT_TYPES} because the answer is a different shape —
 * the bytes come back through this origin as a string the pane renders, not as
 * an object-store URL an iframe loads. The object store publishes no CORS
 * policy, so a presigned URL is unreadable to a `fetch` anyway; that is the same
 * constraint `streamDocumentFile` exists for.
 *
 * `text/html` is deliberately absent and must stay absent. These bytes are
 * uploaded by users and would be returned same-origin.
 */
const TEXT_PREVIEW_CONTENT_TYPES: readonly string[] = SHARED_TEXT_PREVIEW_CONTENT_TYPES

/**
 * How much of a text document crosses the wire for a preview.
 *
 * A preview is a look at a file, not a delivery of it — the download button is
 * two centimetres away and is the honest route to the whole thing. 256 KiB is
 * some 4000 lines of prose, past the point where anyone is reading rather than
 * searching, and it bounds a response that would otherwise be the upload limit.
 */
const TEXT_PREVIEW_MAX_BYTES = 256 * 1024

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
 * timeout (→ 504). Ingest dispatch is best-effort (a timeout is retried once
 * against the idempotent `/v1/ingest`, and a second one is recorded as a
 * failed ingest); the tag edit is user-blocking (a timeout
 * surfaces as an UpstreamError, same as any other transport failure).
 */
const BACKEND_FETCH_TIMEOUT_MS = 10_000

/**
 * The longest the preview and file routes wait for an office file's rendition
 * to be made on first open. Under Cloudflare's ~100s origin timeout with room
 * for the rest of the request, so a slow conversion is answered as the handled
 * `RENDITION_FAILED` 502 rather than an edge 524. The conversion itself keeps
 * its full budget (`GOTENBERG_TIMEOUT_MS` in `./rendition`) and stores its PDF
 * for the next open.
 */
const RENDITION_READER_WAIT_MS = 85_000

/**
 * Stored on the document when the backend ingest dispatch never yielded a job.
 * Persisted server-side (like backend-produced error messages), so it cannot
 * go through the per-user i18n dictionaries.
 */
export const INGEST_DISPATCH_FAILED_MESSAGE = 'Ingestion could not be started'

/**
 * One `POST /v1/ingest`, bounded. `jobId` is null for anything but a job id;
 * `timedOut` says the budget ran out, the one outcome that leaves the backend's
 * side unknown (see {@link dispatchIngest}).
 */
async function requestIngestJob(
  body: string,
  organizationId: string
): Promise<{ jobId: string | null; timedOut: boolean }> {
  try {
    const response = await fetch(`${getBackendUrl()}/v1/ingest`, {
      method: 'POST',
      // Forward the org id so the backend resolves the org's BYOK vision
      // credential + runtime model override for VLM captioning during ingestion.
      headers: { 'Content-Type': 'application/json', 'x-grid-organization-id': organizationId },
      body,
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return { jobId: null, timedOut: false }
    const result: unknown = await response.json()
    const jobId =
      typeof result === 'object' && result !== null ? (result as { job_id?: unknown }).job_id : null
    return { jobId: typeof jobId === 'string' && jobId ? jobId : null, timedOut: false }
  } catch (error) {
    // Anything else never reached the backend or broke on the way back: the
    // shared failed path applies.
    return { jobId: null, timedOut: isTimeoutError(error) }
  }
}

function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TimeoutError'
  )
}

/**
 * How long the presigned URLs handed to an ingest JOB stay valid: `file_ref`,
 * `preview_ref` / `extraction_ref`, and the `thumbnail_upload_url` PUT.
 *
 * The job, not the dispatch request, uses them: `/v1/ingest` queues the work
 * and answers at once, and the backend's worker pool (two workers) reaches a
 * job only when the ones ahead of it finish. A folder upload or a project
 * reindex of a few hundred plan sets queues well past an hour, and a URL that
 * expired in the queue fails the document as `original_download_failed` (or,
 * for the rendition, `office_rendition_required`) although nothing is wrong
 * with it. A day covers any queue this deployment can build; SigV4 caps a
 * presigned URL at seven days.
 *
 * The length is affordable because these URLs never leave the server side:
 * signed with the internal-endpoint client, sent only in the POST body to the
 * backend, which neither stores nor logs them, and never persisted here.
 */
const INGEST_JOB_REF_TTL_SECONDS = 86_400

/**
 * Why a Word or presentation file was not indexed: its PDF could not be made.
 *
 * Its text is read from the rendition and from nothing else (ADR-0071), so no
 * PDF means no index — said as a failure the reader can retry, never papered
 * over by reading the original a worse way.
 */
export const RENDITION_REQUIRED_MESSAGE = 'The PDF version of this file could not be created'

/**
 * Filenames are user-controlled and end up in the `Content-Disposition` of
 * presigned URLs — strip header-breaking characters (CR/LF, double quotes),
 * cap the length, and never emit an empty name.
 */
function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n"]/g, '')
    .trim()
    .slice(0, 255)
  return cleaned || 'download'
}

/** RFC 5987 percent-encoding for the `filename*` parameter. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
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
 * Dispatch a document to the backend ingest API and persist the outcome. The
 * upload and re-ingest paths share this so the success path (status pending +
 * jobId) and the failure path (status failed + errorMessage) stay identical.
 *
 * Best-effort: the file is already durable in SeaweedFS + Postgres. Two outcomes:
 *   - a job id came back  → status pending  (setDocumentIngestJob)
 *   - anything else        → status failed   (markDocumentIngestFailed)
 *
 * The third shape the old code allowed — OK without a job id, row left at its
 * 'uploaded' birth status — is gone on purpose: the backend answers 202 with a
 * `job_id` on every success, so that shape was never a quieter success, and
 * the birth status renders as a green "Ready" the document has not earned.
 */
/**
 * The things only some dispatch callers know.
 *
 * One trailing bag rather than more positionals on a function that already
 * takes six. They arrive in pairs: the join key and provenance from the caller
 * that read the row, the two rendition reads from the office path that
 * converted it.
 */
export interface DispatchIngestExtras {
  /**
   * The `documents.filename` these bytes are known by — the retrieval index's
   * join key. Omitted only where the ingested object is not the row's file.
   */
  fileName?: string | null
  /** Set only for a published Piloti document. */
  provenance?: AgentDocumentProvenance | null
  /**
   * A signed read of the office original's PDF rendition (ADR-0070), for the
   * card thumbnail: the backend cannot rasterise a `.docx`. Set only by
   * {@link beginRenditionIngest}, and only when the conversion succeeded.
   */
  previewRef?: string | null
  /**
   * The same signed read, for TEXT extraction (ADR-0071): the backend indexes
   * the PDF instead of the original iff this is present. Which formats get it is
   * the dispatch's decision (`extractsFromRendition`), never the backend's.
   */
  extractionRef?: string | null
  /**
   * `bulk` for work nobody is waiting on (a reindex, a rescan): inside one
   * organization the backend claims an interactive ingest first (ADR-0081).
   * Absent is interactive, and the field is then not sent at all, so a person's
   * upload is byte for byte what it was before the field existed.
   */
  priority?: IngestPriority
}

/**
 * The two priorities `POST /v1/ingest` accepts. `ingest-priority-contract.spec.ts`
 * pins this list to the backend's `IngestRequest.priority`.
 */
export const INGEST_PRIORITIES = ['interactive', 'bulk'] as const
export type IngestPriority = (typeof INGEST_PRIORITIES)[number]

/**
 * What a published Piloti document carries into the retrieval index.
 *
 * The four keys are spelled here and parsed in
 * `src/aiq_agent/common/provenance.py`; the pair is the whole contract, and a
 * typo on either side is silent — a human document is what an unmarked chunk
 * looks like. So the field names ARE the wire names (snake_case, unlike every
 * other interface in this file) rather than being mapped at the fetch, which is
 * where a rename would go unnoticed.
 *
 * `authored_by` is not optional and has one legal value: this type exists only
 * for documents Piloti wrote, and an absent author is what every human document
 * already sends.
 */
export interface AgentDocumentProvenance {
  authored_by: 'agent'
  /** The DISPLAY NAME of the person who approved it, never their user id. */
  approved_by: string | null
  /** ISO timestamp of that approval. */
  approved_at: string | null
  /** Which pipeline wrote the document — `documents.authored_by_producer`. */
  producer: string | null
}

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
  /**
   * The materialised project-folder path this document is filed under
   * (`Brandschutz/Fluchtwege`), or `null` for the project root / a shelf with no
   * folders. Sent as `folder_path` so the backend can stamp it on the
   * document's metadata row — see ADR-0049. It is the PATH, not the folder id:
   * the backend has no `project_folders` table to join against, the path is what
   * a person reads, and a prefix match over it is the folder's whole subtree.
   */
  folderPath: string | null = null,
  /** See {@link DispatchIngestExtras}. */
  extras: DispatchIngestExtras = {}
): Promise<{ jobId: string | null; status: 'pending' | 'failed' }> {
  const bucket = resolveDocumentBucket(storageBucket)
  // The backend fetches the file itself, from inside the Docker network —
  // sign with the internal-endpoint client, not the browser-facing one.
  // The ingest JOB downloads it, not the request, and the job may start long
  // after dispatch behind the bounded ingest queue: see the constant.
  const presignedUrl = await presignForBackend(
    new GetObjectCommand({ Bucket: bucket, Key: storageKey }),
    INGEST_JOB_REF_TTL_SECONDS
  )

  // Presigned upload slot for the 200px JPEG thumbnail the ingest pipeline
  // generates. Null for a key with no directory segment: there is nowhere to
  // put a sibling, and signing a bucket-root `_thumb.jpg` would hand out a
  // write capability to a shared path rather than to this document's own.
  const thumbnailUploadKey = buildThumbnailStorageKey(storageKey)
  const thumbnailUploadUrl = thumbnailUploadKey
    ? await presignForBackend(
        new PutObjectCommand({
          Bucket: bucket,
          Key: thumbnailUploadKey,
          ContentType: 'image/jpeg',
        }),
        // Written by the same job at its end, so it must outlive the queue too.
        INGEST_JOB_REF_TTL_SECONDS
      )
    : null

  // Who the ingestion's model spend is booked to on the usage ledger, beside
  // the organization: the document's project and the member who put it there.
  // Read from the row rather than threaded through every caller; a failed read
  // books the spend to the organization alone, never fails the dispatch.
  const attribution = await findDocumentInOrg(documentId, organizationId).catch(() => null)
  // The content gate's rules (ADR-0085). Every path into the index passes this
  // line — upload, re-ingest, re-index, Archiv, chat, the IFC digest — so the
  // gate is not something a new caller has to remember.
  const screening = await ingestScreeningFor(organizationId, attribution)

  const body = JSON.stringify({
    file_ref: presignedUrl,
    collection: collectionName,
    document_id: documentId,
    project_id: attribution?.projectId ?? null,
    user_id: attribution?.createdBy ?? null,
    thumbnail_upload_url: thumbnailUploadUrl,
    // A PDF of an office original (ADR-0070), for the thumbnail: the
    // backend cannot rasterise a .docx. Null for everything else and
    // whenever conversion is off or failed. A presigned URL is a bearer
    // credential, so the backend neither stores nor logs it.
    preview_ref: extras.previewRef ?? null,
    // The same PDF, for the TEXT (ADR-0071): present only for the formats
    // `extractsFromRendition` names, and the backend then indexes it
    // instead of `file_ref`. Chunks keep the row's `file_name` either way —
    // only the bytes read differ, never the identity.
    extraction_ref: extras.extractionRef ?? null,
    folder_path: folderPath,
    // Null when screening is off for the organization or a reviewer released
    // these exact bytes from quarantine; the job then reads as it always did.
    screening,
    // The document's IDENTITY inside the collection, stated rather than
    // left to be derived. Without it the backend reads the name off the
    // presigned URL's last path segment, which is the OBJECT KEY's
    // basename — and `storageKeySegment` has already flattened that
    // (`piloti/<id>/x.md` becomes `piloti_<id>_x.md`, a name with a
    // backslash or over 255 characters becomes a different one again). The
    // chunks would then be filed under a string no purge ever asks for,
    // because every purge addresses `documents.filename`. `null` keeps the
    // old derivation for the one caller that genuinely ingests a different
    // file than the row names — the IFC digest.
    file_name: extras.fileName ?? null,
    // Only a bulk dispatch says so: the backend's default is interactive.
    ...(extras.priority === 'bulk' ? { priority: 'bulk' } : {}),
    // Absent for every human document, and the Python side treats absent,
    // null and a non-agent author identically (`parse_agent_provenance`).
    // Spread so the four keys are the four keys, never a nested object the
    // chunk metadata would have to be taught to flatten.
    ...(extras.provenance ?? {}),
  })

  // A timeout is not a failure the backend reported: the request may still be
  // downloading, and would then start the job after this caller had recorded
  // `failed` — a false failure, and a duplicate once someone retries. The
  // backend is idempotent per document and object (`/v1/ingest`), so the same
  // request once more either joins the job the first one started or, when the
  // first never arrived, starts it. Only a second timeout records a failure.
  let attempt = await requestIngestJob(body, organizationId)
  if (attempt.timedOut) attempt = await requestIngestJob(body, organizationId)
  const ingestJobId = attempt.jobId

  if (ingestJobId) {
    await setDocumentIngestJob(documentId, organizationId, ingestJobId)
    return { jobId: ingestJobId, status: 'pending' }
  }
  // No job id, failed or not. The backend answers 202 with a `job_id` on every
  // success (`aiq_api/routes/ingest.py`), so an OK response without one is not
  // a quieter success — it is a response this caller does not understand, and
  // leaving the row at its birth status ('uploaded', which the badge renders
  // green "Ready") would promise citations for a document nothing ever
  // indexed. Failed with retry offered is the honest state either way.
  await markDocumentIngestFailed(documentId, organizationId, INGEST_DISPATCH_FAILED_MESSAGE)
  return { jobId: null, status: 'failed' }
}

/**
 * List one page of a project's documents (bounded, keyset-paginated), lazily
 * reconciling in-flight ingestion statuses with the backend and merging the
 * backend's read-only document metadata (summary, page/chunk counts, content
 * types). The internal `metadata` jsonb column (which carries `ingestJobId`)
 * never leaves the BFF; the curated metadata fields ride alongside as
 * top-level properties.
 *
 * `nextCursor` is where the next page starts, `null` on the last one. The
 * listing used to be one page of 500 with nothing saying so: in a big project
 * the oldest plans were simply absent, so search, filters and the folder-upload
 * planner (which labelled them „Neu") worked on a corpus that was not the
 * project's. A client that needs the whole corpus follows the cursor.
 */
export async function listDocumentsPage(
  session: AuthorizedSession,
  projectId: string,
  /**
   * Narrowing options. `authoredBy` is pushed down to the query rather than
   * filtered here: the „Von Piloti" chip asks for the small minority of rows a
   * machine wrote, migration 0063 gave that predicate its own partial index,
   * and filtering after the fact would read the whole project's corpus — plus
   * reconcile and assignment-hydrate every row of it — to return a handful.
   */
  options: { authoredBy?: DocumentAuthor; includeArchived?: boolean; cursor?: DocumentListCursor } = {}
): Promise<{ documents: ListedDocument[]; nextCursor: string | null }> {
  await requireProjectAccess(session, projectId, 'project:view')

  // `limit` is deliberately not passed: the repository's own default is the
  // page size, and a second copy of it here could drift from the real one.
  const page = await listProjectDocumentPage(projectId, session.organizationId, {
    authoredBy: options.authoredBy,
    // Archived documents have LEFT the working set, so they are absent unless
    // the caller says otherwise (ADR-0054).
    includeArchived: options.includeArchived,
    cursor: options.cursor,
  })
  return toListedPage(session, page)
}

/**
 * The project's documents NAMED `filenames` (case-insensitive, either Unicode
 * form), as listing rows — the by-name resolve (`POST /api/documents/by-name`).
 *
 * For the readers that want particular documents rather than the corpus: a
 * citation chip, a surfaced-documents card, a file operation naming its file.
 * They used to read the first listing page and look the name up in it, so a
 * cited document older than the newest 500 resolved to nothing. Same gate and
 * same row as the listing; archived documents are left out as they are there.
 */
export async function resolveProjectDocumentsByName(
  session: AuthorizedSession,
  projectId: string,
  filenames: readonly string[]
): Promise<ListedDocument[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  const rows = await findProjectDocumentsByFilenames(projectId, session.organizationId, filenames)
  return toListedDocuments(session, rows)
}

/**
 * The FIRST page of a project's documents — {@link listDocumentsPage} without
 * the cursor. Kept for the server-side callers that want a bounded sample
 * rather than the corpus; anything that must see every document pages.
 */
export async function listDocuments(
  session: AuthorizedSession,
  projectId: string,
  options: { authoredBy?: DocumentAuthor; includeArchived?: boolean } = {}
): Promise<ListedDocument[]> {
  return (await listDocumentsPage(session, projectId, options)).documents
}

/**
 * Which of `names` this project's shelf already holds — the upload planner's
 * question, asked of the database rather than of the listing a browser loaded
 * (which is paged, can be narrowed by a filter, and leaves archived documents
 * out, while the upload replaces by filename across all of them).
 *
 * Same gate as the listing: the answer is names and ids a `project:view`
 * reader can already page through.
 */
export async function probeProjectDocumentNames(
  session: AuthorizedSession,
  projectId: string,
  names: readonly string[]
): Promise<DocumentNameMatchRow[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  return findProjectDocumentsByNames(projectId, session.organizationId, names)
}

export type { ListedDocument }

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
  topKFiles: number
): Promise<BackendSearchHit[]> {
  const scopeHeaders = buildGridRequestContextWireHeaders(
    { collectionScope: [collectionName] },
    process.env.GRID_INTERNAL_API_TOKEN
  )
  try {
    const res = await fetch(
      `${getBackendUrl()}/v1/collections/${encodeURIComponent(collectionName)}/search`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...scopeHeaders },
        body: JSON.stringify({ query, top_k: deriveSearchTopK(topKFiles), top_k_files: topKFiles }),
        signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
      }
    )
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
  T extends { filename: string; createdAt: Date | string; authoredBy: string },
>(hits: BackendSearchHit[], files: T[]): Array<SearchedDocument<T>> {
  const byName = new Map<string, T>()
  for (const file of files) {
    // Only a human-authored row may take a hit. A filename is not an identity
    // across authorship: `generatedFilename` builds `slug(title)-DATE.ext` from a
    // title the model wrote, so a collision with a real document is reachable by
    // the model, and recency would then hand it that document's snippet and page
    // under a „Von Piloti erstellt" label.
    //
    // `authoredBy` is required rather than optional on purpose. Both callers
    // select it (`documentListColumns`); making it optional would
    // mean a future caller that forgets the column fails OPEN at runtime instead
    // of failing to compile.
    if (file.authoredBy !== 'user') continue
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
 * `project:view`, resolves the project's RAG collection, runs the deterministic
 * vector search on the backend, and joins the hits to the project's own file
 * rows by filename. Fail-open: a backend error/timeout yields `{ hits: [] }`,
 * never a crash.
 *
 * The rows are looked up BY THE HIT NAMES, as `searchArchivDocuments` does,
 * never read from the listing: the listing is paged, and a hit on a document
 * past its first page used to be dropped as if the search had not found it.
 */
export async function searchProjectDocuments(
  session: AuthorizedSession,
  projectId: string,
  query: string,
  topK = 20
): Promise<{ hits: Array<SearchedDocument<ListedDocument>> }> {
  await requireProjectAccess(session, projectId, 'project:view')

  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')

  const hits = await fetchSemanticHits(project.collectionName, query, topK)
  if (hits.length === 0) return { hits: [] }
  // The canonical rows, hydrated exactly as the listing hydrates them, so a
  // semantic result is always a real, visible document with its live status.
  const rows = await findProjectDocumentsByFilenames(
    projectId,
    session.organizationId,
    hits.map((hit) => hit.file_name)
  )
  return { hits: joinHitsToFiles(hits, await toListedDocuments(session, rows)) }
}

export interface UploadDocumentInput {
  projectId: string
  folderId: string | null
  file: File
  /**
   * Where the file sat before it was uploaded, when the browser knows — a
   * folder upload reports `webkitRelativePath`. Absent for a picked file.
   * Recorded once (migration 0072) and never rewritten; see the schema comment
   * for why this is not Piloti's own folder path.
   */
  originPath?: string | null
  /**
   * The uploader released this file in the upload dialog although the
   * organization's name screening excludes it (ADR-0085) — the Bauvertrag in a
   * folder called „Verträge". Honoured and audited; absent means "do not
   * override", so a client that never asks is screened.
   */
  screeningRelease?: boolean
  /**
   * The upload gesture this file belongs to (migration 0109), as the browser
   * opened it. Recorded on the row when it is the uploader's own open batch
   * for this project; anything else is ignored rather than refused.
   */
  uploadBatchId?: string | null
}

export type { UploadDocumentResult }

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
export async function assertUploadTypeAllowed(
  session: AuthorizedSession,
  filename: string
): Promise<void> {
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
 * ingestion — the project's name for the shelf-parameterised pipeline in
 * `./shelf-upload`, which the Archiv shares. Requires `project:documents:write`
 * (or `project:edit`) on the project.
 */
export function uploadDocument(
  session: AuthorizedSession,
  input: UploadDocumentInput,
  request: Request
): Promise<UploadDocumentResult> {
  return uploadToShelf(session, projectShelf(input.projectId), input, request)
}

export interface BeginModelExtractionInput {
  organizationId: string
  projectId: string | null
  documentId: string
  filename: string
  storageKey: string
  storageBucket: string | null
  collectionName: string
  /**
   * Materialised folder path the document is filed under, or `null`/absent for
   * the project root. Travels to the backend as `folder_path` (ADR-0049) so
   * surfacing and retrieval can see the filing; the Archiv and session shelves
   * have no folders and simply omit it.
   */
  folderPath?: string | null
  /** See {@link DispatchIngestExtras.priority}. Set by the reindex and rescan jobs. */
  priority?: IngestPriority
}

/**
 * What a stored object needs before anything can be started for it.
 *
 * `BeginModelExtractionInput` plus the one field only the ingest branch reads,
 * because the IFC branch is otherwise the one that needs more: `dispatchIngest`
 * uses a strict subset of these fields.
 */
export interface DispatchDocumentInput extends BeginModelExtractionInput {
  /**
   * WHICH VERSION these bytes are — the half of the publish door the row cannot
   * answer on its own (ADR-0054).
   *
   * A machine-authored document is refused unless this names the row's
   * `published_version_id`, so a draft, an in-review version, an
   * approved-but-unpublished one, a superseded one and a rejected one all fail
   * the same check rather than each needing to be listed. Absent means "the
   * caller is not dispatching a particular version", which is every human
   * upload path and every re-index — and which an agent-authored row is refused
   * for, exactly as it was before this door existed.
   */
  versionId?: string | null
  /**
   * The provenance a published Piloti document carries into every chunk
   * (`docs/architecture/agent-document-provenance.md`).
   *
   * Never assembled here: this tier does not know who approved anything. It is
   * built by the `ingestPublished` effect, which is the only caller that has a
   * version row and a directory in hand, and travels verbatim onto the wire so
   * the keys the Python side parses are the keys the BFF wrote.
   */
  provenance?: AgentDocumentProvenance | null
}

export interface DispatchDocumentResult {
  jobId: string | null
  /**
   * `processing` is a detached path: an IFC model ({@link beginModelExtraction})
   * or an office file converting first ({@link beginRenditionIngest}).
   */
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
 * Thrown when something tries to index a document a machine wrote and nobody
 * published.
 *
 * Named and exported so a caller can tell this refusal apart from a backend
 * failure: one is a bug in the caller, the other is an outage.
 */
export class AgentAuthoredDocumentNotIndexableError extends Error {
  constructor(readonly documentId: string) {
    super(
      `document ${documentId} was written by a machine and is not a published version, so it must not be indexed`
    )
    this.name = 'AgentAuthoredDocumentNotIndexableError'
  }
}

export async function dispatchDocument(
  input: DispatchDocumentInput
): Promise<DispatchDocumentResult> {
  /**
   * A document a machine wrote reaches the retrieval index in exactly ONE case,
   * and it is checked HERE, at the one place every ingestion path funnels
   * through, by READING THE ROW rather than by trusting the caller.
   *
   * ## The one case, and why it is a row invariant
   *
   * The rule used to be "human-authored, full stop". ADR-0054 widened it by one
   * clause and no more: an agent-authored row passes when the dispatch names
   * the version the row's `published_version_id` points at. Everything else a
   * version can be — `draft`, `in_review`, `changes_requested`, `approved` but
   * not yet published, `superseded`, `rejected` — fails the SAME comparison
   * rather than being enumerated, so a later state cannot be forgotten here.
   *
   * The clause is worth exactly as much as what stands behind it, and what
   * stands behind it is the database: `document_versions_published_is_approved`
   * refuses a published row with no `approved_by`/`approved_at`, and
   * `uniq_document_versions_published_per_document` refuses a second published
   * version. So `published_version_id` names a version a PERSON approved, and
   * "indexed ⟹ published ⟹ approved by a person" is a chain of constraints
   * rather than a chain of call sites.
   *
   * The version id travels in the input because the row cannot supply it: the
   * question is not "does this document have a published version" but "are
   * these the published version's bytes". A re-index that enumerated documents
   * and re-dispatched them names no version and is refused, which is what keeps
   * „Projekt neu indizieren" from putting a superseded draft back in the index.
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
  // An allow-list on a row that must EXIST. `if (row && …)` read a missing row
  // as permission to ingest, which is the one default this guard was moved here
  // to stop making: the argument for reading the row is "never trust the
  // caller", and treating an absent row as `user` trusts the caller about the
  // only thing left. No caller reaches this without having inserted first, so
  // the refusal costs nothing today; it is what keeps the next one honest.
  if (!row || !mayBeIndexed(row, input.versionId ?? null)) {
    throw new AgentAuthoredDocumentNotIndexableError(input.documentId)
  }

  if (isIfcFilename(input.filename)) {
    return beginModelExtraction(input)
  }
  // Decided on the ROW's name and stored type, like the preview route decides
  // what to serve, so a file is indexed from the same PDF a reader is shown.
  if (isRenditionEnabled() && servedAsRendition(row)) {
    return beginRenditionIngest(input, row.filename)
  }
  // Without a converter a Word or presentation file has no source to index
  // from. The file is still stored and downloadable; the row says why it is not
  // citable instead of pretending to be ingested.
  if (servedAsRendition(row) && extractsFromRendition(row.filename)) {
    await markDocumentIngestFailed(input.documentId, input.organizationId, RENDITION_REQUIRED_MESSAGE)
    return { jobId: null, status: 'failed' }
  }
  return dispatchIngest(
    input.documentId,
    input.collectionName,
    input.storageKey,
    input.organizationId,
    input.storageBucket,
    input.folderPath ?? null,
    // The ROW's filename, not the caller's: the join key belongs to the row,
    // and this is the same "never trust the caller" argument the guard above
    // makes about authorship.
    { fileName: row.filename, provenance: input.provenance ?? null, priority: input.priority }
  )
}

/**
 * Whether this document, dispatched for this version, may be indexed.
 *
 * Split out of {@link dispatchDocument} so the rule is one expression a reader
 * can hold: a person's document always, a machine's only as its own published
 * version. `dispatch.spec.ts` walks every version state through it.
 */
function mayBeIndexed(
  row: Pick<Document, 'authoredBy' | 'publishedVersionId'>,
  versionId: string | null
): boolean {
  if (row.authoredBy === 'user') return true
  return Boolean(row.publishedVersionId) && row.publishedVersionId === versionId
}

/**
 * The queue priority of work the way ingestion names it: a person's upload is
 * `interactive` (the default), a reindex or a rescan says `bulk`.
 */
function jobPriorityOf(priority: IngestPriority | undefined): BffJobPriority {
  return BFF_JOB_PRIORITY[priority ?? 'interactive']
}

/** The part of a dispatch every background document job carries. */
function documentWorkPayload(input: DispatchDocumentInput) {
  return {
    projectId: input.projectId,
    documentId: input.documentId,
    filename: input.filename,
    storageKey: input.storageKey,
    storageBucket: input.storageBucket,
    collectionName: input.collectionName,
    folderPath: input.folderPath ?? null,
    versionId: input.versionId ?? null,
    priority: input.priority ?? ('interactive' as const),
  }
}

/**
 * Hand a stored document's background work to the `bff-jobs` pool and say so on
 * the row.
 *
 * The row is `processing` before this is called, so it never reads as a green
 * "Ready" for work nobody has done. The job is the work's only owner from here:
 * it outlives this request and the process that took it, and it is claimed
 * fairly across organizations, so a person's upload waits behind their own
 * office's work at most, never behind another's.
 *
 * A job of this kind already open for the SAME object is returned instead of a
 * second one: a retry, a reindex and the sweep that recovers stranded rows all
 * arrive here for a row that may already be queued. The object's key is part of
 * the match, so a document whose bytes were replaced while the first job
 * waited still gets a job for the new bytes.
 *
 * When the queue cannot be written the row says so and the caller is told
 * `failed`, exactly as a backend that refuses an ingest is. A row left at
 * `processing` with nothing behind it would read as work in progress for good.
 */
async function queueDocumentWork(
  kind: 'bim_extract' | 'office_rendition',
  input: DispatchDocumentInput,
  payload: Record<string, unknown>
): Promise<DispatchDocumentResult> {
  try {
    // The document's own organization, stated: callers reach this from a
    // request, an effect and a sweep, and the queue's policy compares the lane
    // to the tenant.
    await withTenant({ organizationId: input.organizationId }, async () => {
      const matching = { documentId: input.documentId, storageKey: input.storageKey }
      const open = await findOpenJobId({ kind, organizationId: input.organizationId, matching })
      const jobId =
        open ??
        (
          await enqueueJob({
            kind,
            organizationId: input.organizationId,
            priority: jobPriorityOf(input.priority),
            payload,
          })
        ).jobId
      await setDocumentBackgroundJob(input.documentId, input.organizationId, jobId)
    })
    return { jobId: null, status: 'processing' }
  } catch (error) {
    console.warn(
      `[documents] ${kind} could not be queued:`,
      error instanceof Error ? error.message : String(error)
    )
    await markDocumentIngestFailed(input.documentId, input.organizationId, INGEST_DISPATCH_FAILED_MESSAGE).catch(
      () => undefined
    )
    return { jobId: null, status: 'failed' }
  }
}

/**
 * Queue IFC extraction for a stored `.ifc` object and return the same shape
 * `dispatchIngest` does, so the upload path stays one expression.
 *
 * Extraction is a JOB (`bim_extract`), not awaited and not detached in this
 * process. A 60 MB model takes tens of seconds to parse and several times its
 * own size in memory, and the caller is an HTTP request that has already stored
 * the bytes: parsing here would trade a durable upload for a gateway timeout,
 * and parsing on the user-facing pod would put it on the event loop that also
 * proxies chat. The `bff-jobs` pool parses it instead (ADR-0081), bounded by its
 * concurrency and scaled on the queue. The document is marked `processing`
 * first, so the row never renders as a green "Ready" for a model that cannot be
 * opened yet, and every terminal outcome of the job writes the row again
 * ({@link runBimExtractJob}):
 *
 *   - parse succeeded → the digest is dispatched, which sets `pending` + job id
 *   - parse failed    → `failed` with the reason, and a `bim_models` row that
 *                       records the same thing for the model surfaces
 *
 * A restart no longer strands the model at `extracting`: the claim goes back to
 * the queue and the next worker parses it again.
 */
export async function beginModelExtraction(
  input: BeginModelExtractionInput
): Promise<{ jobId: string | null; status: 'pending' | 'uploaded' | 'failed' | 'processing' }> {
  await markDocumentProcessing(input.documentId, input.organizationId)
  return queueDocumentWork('bim_extract', input, documentWorkPayload(input))
}

/**
 * The job half of {@link beginModelExtraction}: parse the model, store its
 * index and digest, and dispatch the digest to the ordinary ingest path.
 *
 * Runs on a `bff-jobs` pod, as the system. The row is read again because the
 * job may have waited for hours: a document deleted or replaced meanwhile, or
 * already moved on by the claim of a worker that died after finishing, is left
 * alone. `runBimExtraction` does not throw for a model it cannot read (that is a
 * documented state of the model), so a throw here is infrastructure and goes
 * back to the queue; the last attempt leaves the row failed first.
 */
export async function runBimExtractJob(
  organizationId: string,
  payload: BimExtractPayload,
  attempt: JobAttempt
): Promise<void> {
  const input = dispatchInputOf(organizationId, payload)
  if (!(await jobStillOwnsRow(input))) return

  await failRowOnLastAttempt(input, attempt, 'IFC extraction failed', async () => {
    const outcome = await runBimExtraction({
      organizationId,
      projectId: input.projectId,
      documentId: input.documentId,
      filename: input.filename,
      storageKey: input.storageKey,
      storageBucket: input.storageBucket,
      // No `fileName`: what is ingested here is the Markdown DIGEST, not the
      // model the row names, so the backend's own derivation from the presigned
      // URL (`digest.md`) is what these chunks have always been filed under.
      // Stating `input.filename` would rename them to `haus.ifc` and orphan every
      // chunk already written under the old name. That the row's purge therefore
      // addresses a name its chunks do not carry is a defect this change did not
      // introduce and does not fix.
      dispatchDigest: (digestStorageKey) =>
        dispatchIngest(
          input.documentId,
          input.collectionName,
          digestStorageKey,
          organizationId,
          input.storageBucket,
          input.folderPath ?? null,
          { priority: input.priority }
        ),
    })
    if (outcome.status === 'failed') {
      await markDocumentIngestFailed(input.documentId, organizationId, outcome.error ?? 'IFC extraction failed')
    }
  })
}

/** The dispatch a queued payload stands for. */
function dispatchInputOf(organizationId: string, payload: BimExtractPayload): DispatchDocumentInput {
  return {
    organizationId,
    projectId: payload.projectId,
    documentId: payload.documentId,
    filename: payload.filename,
    storageKey: payload.storageKey,
    storageBucket: payload.storageBucket,
    collectionName: payload.collectionName,
    folderPath: payload.folderPath ?? null,
    versionId: payload.versionId ?? null,
    priority: payload.priority,
  }
}

/**
 * Whether the row still waits for the work a job was queued for.
 *
 * False for a document that was deleted, whose bytes were replaced (the newer
 * dispatch queued its own job) or that is no longer `processing`. The last is
 * the one that matters after a crash: a worker that finished the work and died
 * before it could finish the job leaves a claim another worker takes over, and
 * doing the work a second time would dispatch the same ingest twice. A machine's
 * document is held to the publish rule again, because it may have been
 * superseded while it waited.
 */
async function jobStillOwnsRow(input: DispatchDocumentInput): Promise<boolean> {
  const row = await findDocumentInOrg(input.documentId, input.organizationId)
  if (!row) return false
  if (row.storageKey !== input.storageKey || row.status !== 'processing') return false
  return mayBeIndexed(row, input.versionId ?? null)
}

/**
 * Run `work`; when it throws on the last attempt the queue gives it, say so on
 * the row before the queue buries the job. The error is rethrown either way, so
 * the queue still counts the attempt.
 */
async function failRowOnLastAttempt(
  input: DispatchDocumentInput,
  attempt: JobAttempt,
  message: string,
  work: () => Promise<void>
): Promise<void> {
  try {
    await work()
  } catch (error) {
    if (attempt.last) {
      await markDocumentIngestFailed(input.documentId, input.organizationId, message).catch(() => undefined)
    }
    throw error
  }
}

/**
 * Queue the conversion of an office original to its PDF rendition, and the
 * ingest that follows — a JOB (`office_rendition`), like
 * {@link beginModelExtraction} and for the same reason (ADR-0071).
 *
 * The conversion used to be raced against a 20-second wait inside the upload
 * request, because a person was waiting on it and the PDF only fed the
 * thumbnail. Now it also decides what text is indexed, so a deck that took 25
 * seconds would be indexed from a different source than one that took 15 —
 * and a slow conversion would silently index the worse text. As a job the
 * conversion gets its full two minutes and nobody waits on it.
 *
 * Why a job and not a promise in this process: a folder of three hundred office
 * files started three hundred conversions in the upload's pod, queued behind a
 * per-process FIFO of two Gotenberg slots, in front of the fair ingest queue
 * that ADR-0076 made fair. Now the backlog sits in the queue, claimed fairly
 * across organizations, and the fleet runs at most as many conversions as the
 * `bff-jobs` pool is sized for (`deploy/pulumi/src/app/bff-jobs.ts`). The
 * per-process FIFO in `./rendition` stays for the one path where a person IS
 * waiting: the preview and file routes.
 *
 * The row goes to `processing` first, exactly as an IFC model does, so it never
 * renders a green "Ready" before anything was dispatched. Every terminal outcome
 * writes the row again: a dispatch sets `pending` + job id or `failed` itself,
 * and {@link runOfficeRenditionJob} covers anything that throws before it.
 */
export async function beginRenditionIngest(
  input: DispatchDocumentInput,
  fileName: string
): Promise<DispatchDocumentResult> {
  await markDocumentProcessing(input.documentId, input.organizationId)
  return queueDocumentWork('office_rendition', input, {
    ...documentWorkPayload(input),
    fileName,
    provenance: input.provenance ?? null,
  })
}

/**
 * The job half of {@link beginRenditionIngest}. Same guards and same last-attempt
 * rule as {@link runBimExtractJob}.
 *
 * A conversion the converter refuses is not an error here: the document fails
 * with {@link RENDITION_REQUIRED_MESSAGE}, which is what "Erneut lesen"
 * retries, and the job is finished. A retry by the queue would run the same
 * file through the same converter again within the minute.
 */
export async function runOfficeRenditionJob(
  organizationId: string,
  payload: OfficeRenditionPayload,
  attempt: JobAttempt
): Promise<void> {
  const input = { ...dispatchInputOf(organizationId, payload), provenance: payload.provenance ?? null }
  if (!(await jobStillOwnsRow(input))) return

  await failRowOnLastAttempt(input, attempt, INGEST_DISPATCH_FAILED_MESSAGE, () =>
    ingestThroughRendition(input, payload.fileName)
  )
}

/**
 * The conversion and ingest {@link runOfficeRenditionJob} runs.
 *
 * For a Word or presentation file the rendition IS the source, so a failed
 * conversion fails the document with {@link RENDITION_REQUIRED_MESSAGE}; the
 * existing retry re-runs the conversion. A spreadsheet only loses its
 * thumbnail and is ingested from the original as before.
 */
async function ingestThroughRendition(input: DispatchDocumentInput, fileName: string): Promise<void> {
  const renditionRef = await signedRenditionRef(input, fileName)
  const indexesRendition = extractsFromRendition(fileName)
  if (indexesRendition && !renditionRef) {
    await markDocumentIngestFailed(input.documentId, input.organizationId, RENDITION_REQUIRED_MESSAGE)
    return
  }
  await dispatchIngest(
    input.documentId,
    input.collectionName,
    input.storageKey,
    input.organizationId,
    input.storageBucket,
    input.folderPath ?? null,
    {
      fileName,
      provenance: input.provenance ?? null,
      previewRef: renditionRef,
      // A spreadsheet's rendition is a thumbnail only: its text keeps the
      // structure-preserving extractor (see `extractsFromRendition`).
      extractionRef: indexesRendition ? renditionRef : null,
      priority: input.priority,
    }
  )
}

/**
 * A signed read of the rendition, or `null` when there is none to give.
 *
 * Signed with the INTERNAL client like `file_ref`: the backend reads it from
 * inside the Docker network, as part of the job, so it is minted right before
 * the POST rather than when the conversion started.
 *
 * Valid for {@link INGEST_JOB_REF_TTL_SECONDS}, like `file_ref` and the
 * thumbnail slot, not for the default presign TTL: the job downloads it when an
 * ingest worker reaches it, and behind a queue of plan sets that can be hours.
 * An expired link fails the document as `office_rendition_required`, which
 * would read as a converter fault.
 */
async function signedRenditionRef(input: DispatchDocumentInput, fileName: string): Promise<string | null> {
  const bucket = resolveDocumentBucket(input.storageBucket)
  try {
    const renditionKey = await ensureRendition({ bucket, storageKey: input.storageKey, filename: fileName })
    return await presignForBackend(new GetObjectCommand({ Bucket: bucket, Key: renditionKey }), INGEST_JOB_REF_TTL_SECONDS)
  } catch (error) {
    console.warn(
      '[documents] office rendition at ingest failed:',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

export interface ReingestDocumentResult {
  id: string
  status: 'pending' | 'uploaded' | 'failed' | 'processing'
  jobId: string | null
}

/**
 * Re-dispatch a document to the backend ingest API, keeping its id.
 *
 * Three kinds of row are eligible, each for its own reason:
 *
 *  - failed, or stranded at the `uploaded` birth status: a plain retry.
 *  - in flight (`pending`, `processing`, …): only when the backend has LOST
 *    the job — see the branch below.
 *  - indexed (the `success` family, e.g. `completed`) and written by a person:
 *    a deliberate re-read of an unchanged file, to pick up a change to how
 *    files are READ (ADR-0071 taught Word and PowerPoint to read their
 *    pictures; nothing in the upload path would notice that). Safe because the
 *    backend replaces a version only once the new one has indexed
 *    (`_retire_previous_version`, `llamaindex/adapter.py`): the old chunks stay
 *    citable for the length of the job, and stay for good if it fails.
 *    An agent-authored row is not offered this: its index entry belongs to a
 *    published version, which only `ingestPublished` may dispatch.
 *
 * Every refusal is a 409 whose `details.code` says why (`./reingest-codes`),
 * so the client can tell "already running" and "already finished" from a
 * failure worth retrying.
 */
export async function reingestDocument(
  session: AuthorizedSession,
  documentId: string,
  options: { priority?: IngestPriority } = {}
): Promise<ReingestDocumentResult> {
  const doc = await getAccessibleDocument(session, documentId, 'write')

  if (!doc.storageKey) throw new NotFoundError('File not available')

  const variant = documentStatusFacts(doc.status)?.variant
  const isIndexed = variant === 'success'
  const isRetryable = variant === 'destructive' || doc.status === 'uploaded'
  const isInFlight = IN_FLIGHT_DOCUMENT_STATUSES.has(doc.status)

  if (isIndexed && doc.authoredBy !== 'user') {
    throw new ConflictError('Only documents a person uploaded can be re-read once indexed', {
      status: doc.status,
      code: INGEST_NOT_ELIGIBLE,
    })
  }
  if (!isIndexed && !isRetryable && !isInFlight) {
    throw new ConflictError('This document is not in a state that can be re-ingested', {
      status: doc.status,
      code: INGEST_NOT_ELIGIBLE,
    })
  }

  if (isInFlight) {
    // In flight: retry only what the backend has LOST. A row can sit at
    // `processing` forever — a backend restart wipes the in-memory job
    // registry, a detached IFC extraction dies with the process — while the
    // old guard answered every one of those with 409 and the user's only way
    // out was delete + re-upload under a NEW id, breaking every citation,
    // chat subject and assignment pointing at the old one. Retrying keeps the
    // id, so nothing pointing at the document breaks.
    //
    // The check is live backend state, not a timer: a row is retryable when
    // the backend knows neither a job nor a file for it. A job that is
    // genuinely running refuses with 409 rather than doubling VLM work.
    const knowledge = await describeBackendIngestState({
      metadata: doc.metadata,
      collectionName: doc.collectionName,
      filename: doc.filename,
      authoredBy: doc.authoredBy,
      publishedVersionId: doc.publishedVersionId,
    })
    if (knowledge.state === 'in-progress') {
      throw new ConflictError('Ingestion is still running for this document', {
        status: doc.status,
        code: INGEST_RUNNING,
      })
    }
    if (knowledge.state === 'unreachable') {
      throw new UpstreamError('The ingestion backend could not be reached, so a retry cannot be verified as safe')
    }
    if (knowledge.state === 'terminal') {
      // Finished behind the row's back (no listing read reconciled it yet).
      // Heal the row either way. A success is not re-dispatched: the reader
      // clicked "retry" on what looked stuck, and it is done. A failure is
      // what they were retrying, so it goes on to the dispatch below.
      await setDocumentReconciledStatus(doc.id, session.organizationId, knowledge.resolution)
      if (knowledge.resolution.status !== 'failed') {
        throw new ConflictError(`Ingestion already ${knowledge.resolution.status} for this document`, {
          status: knowledge.resolution.status,
          code: INGEST_ALREADY_DONE,
        })
      }
    }
  }

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
    folderPath: await resolveDocumentFolderPath(doc, session.organizationId),
    priority: options.priority,
  })
  return { id: doc.id, status, jobId }
}

export interface ReindexProjectResult {
  projectId: string
  /**
   * The job doing the work, on the `bff-jobs` pool (ADR-0081). It outlives this
   * request and the process that took it: a restart gives its claim back and
   * the next worker resumes from the page it stopped at.
   */
  jobId: string
}

/**
 * Documents one reindex slice re-dispatches. Small on purpose: a slice is the
 * unit a draining worker waits for, so it is seconds of work, and the page the
 * job has got to is saved after every one.
 */
export const REINDEX_SLICE_DOCUMENTS = 25

/** Re-dispatch runs this many documents at a time. */
const REINDEX_CONCURRENCY = 4

/**
 * Run `work` over `items`, at most `concurrency` at a time. One item's failure
 * is `work`'s to handle: this never rejects on its account.
 */
async function forEachBounded<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await work(items[next++])
  })
  await Promise.all(workers)
}

/** Keep the names of the first few failures for the log; the count stays exact. */
function recordFailure(counts: JobCounts, name: string): void {
  counts.failed += 1
  if (counts.failedNames.length < FAILED_NAMES_KEPT) counts.failedNames.push(name)
}

/**
 * Rebuild every document's chunks in one project: authorize, then hand the walk
 * to a job.
 *
 * The walk used to run inside this request: up to ten thousand documents in
 * one POST, and a request that died half way left no record of which half.
 * Now the request checks that the caller may rebuild this project and enqueues
 * ONE job (`reindex_project`, bulk), answered 202 with its id. The job pages
 * through the documents on a `bff-jobs` pod, saves its place after every page
 * and dispatches each document to the backend with `priority: "bulk"`, so a
 * person's upload in the same organization is claimed first. A second click
 * while one is open returns that job instead of starting another.
 *
 * The project-wide form of re-reading an indexed document (`reingestDocument`
 * does it for one): every person-authored document with stored bytes goes
 * through `dispatchDocument` again, under its own row filename.
 *
 * There is NO chunk delete first. The backend replaces a version only once the
 * new one has indexed — `_find_previous_versions` collects the old ids before
 * the file is read, `_retire_previous_version` removes exactly those after the
 * file reaches SUCCESS (`llamaindex/adapter.py`; docs/technical-reference/
 * document-ingestion.md, "A re-upload replaces the previous version once it has
 * indexed"). This function used to DELETE the chunks and then dispatch, so any
 * dispatch or ingest failure — a backend blip, an encrypted PDF, a missing VLM
 * key — left a document that answered yesterday with zero chunks today. The
 * backend moved away from delete-first for exactly that reason; the pre-delete
 * here reintroduced it one tier up.
 *
 * What the pre-delete bought is not worth that. The replacement is keyed on the
 * row's own filename, which is also what the delete addressed, so there is no
 * name the delete reached that the replacement does not. The one residual case
 * is the backend's lookup of previous versions failing (it logs and ingests
 * anyway), which leaves a duplicate until the next re-read — a smaller harm
 * than an empty document, and a backend defect to fix there. Nor is this the
 * tool for an embedding-model change: that invalidates the whole collection,
 * which is rebuilt from an empty Chroma directory (same doc, "Embedding-model
 * changes invalidate stored vectors"), not by per-file deletes.
 *
 * Reach for this after a change to how chunks are BUILT rather than to what they are
 * built from — a chunker change alters no file, so nothing in the ordinary upload
 * path would notice.
 */
export async function reindexProject(
  session: AuthorizedSession,
  projectId: string
): Promise<ReindexProjectResult> {
  await requireProjectAccess(session, projectId, ['project:documents:write', 'project:edit'])

  const open = await findOpenJobId({
    kind: 'reindex_project',
    organizationId: session.organizationId,
    matching: { projectId },
  })
  if (open) return { projectId, jobId: open }

  const payload: ReindexProjectPayload = {
    projectId,
    requester: requesterOf(session),
    cursor: null,
    counts: emptyCounts(),
  }
  const { jobId } = await enqueueJob({
    kind: 'reindex_project',
    organizationId: session.organizationId,
    payload,
  })
  return { projectId, jobId }
}

/**
 * Re-dispatch one document of a reindex. `skipped` for a row there is nothing
 * to rebuild from; a dispatch the backend refused throws.
 */
async function redispatchForReindex(
  session: AuthorizedSession,
  row: DocumentListRow
): Promise<'queued' | 'skipped'> {
  // Re-resolved rather than trusted from the list: this is the same read the
  // single-document path uses, it carries the storage key and bucket the list
  // row does not, and it re-checks access per document.
  const doc = await getAccessibleDocument(session, row.id, 'write')
  // Mid-flight rows are skipped: a second dispatch would double the work of
  // one that is running. Every in-flight spelling, not just two of them.
  if (!doc.storageKey || IN_FLIGHT_DOCUMENT_STATUSES.has(doc.status)) return 'skipped'

  // Belt to the query's braces. The listing already asks for `'user'` only, so
  // this is never null in practice; a row that somehow arrives here
  // machine-authored is skipped, not reported failed: it was never eligible,
  // and `dispatchDocument` would refuse it anyway.
  if (!collectionFileRef(doc)) return 'skipped'

  // The bucket the object is ACTUALLY in — see `reingestDocument` for why
  // defaulting this breaks per-organization documents in two directions.
  const { status } = await dispatchDocument({
    organizationId: session.organizationId,
    projectId: doc.projectId,
    documentId: doc.id,
    filename: doc.filename,
    storageKey: doc.storageKey,
    storageBucket: doc.storageBucket,
    collectionName: doc.collectionName,
    folderPath: await resolveDocumentFolderPath(doc, session.organizationId),
    priority: 'bulk',
  })
  // A dispatch the backend refused comes back `failed` rather than throwing;
  // the row says so, and the reindex summary has to as well.
  if (status === 'failed') throw new Error('dispatch failed')
  return 'queued'
}

/**
 * One slice of a `reindex_project` job: the next page of the project's
 * documents, re-dispatched, and the position to resume from.
 *
 * `payload` is the job's state, read back from the queue row, and this returns
 * the state to save. Re-running a slice (its worker died after the dispatches
 * and before the save) re-dispatches the same documents, which the backend
 * accepts: ingestion is idempotent per document and object.
 *
 * Every page, not the first: the keyset order is `created_at`, which a dispatch
 * never touches, so re-dispatching a page cannot move a row across the cursor.
 * `'user'` explicitly, not "everything": a machine-authored document must not be
 * indexed (see `dispatchDocument`), and reaching the dispatcher's refusal would
 * report a project-wide reindex as partially FAILED for rows that were never
 * eligible. The dispatcher is the invariant; this is the caller not asking a
 * question it already knows the answer to.
 */
export async function runReindexSlice(
  session: AuthorizedSession,
  payload: ReindexProjectPayload
): Promise<JobSliceResult<ReindexProjectPayload>> {
  try {
    // The caller's rights are checked again: a job can wait, and a person who
    // lost their role in the meantime must not have it rebuild the project.
    await requireProjectAccess(session, payload.projectId, ['project:documents:write', 'project:edit'])
  } catch (error) {
    if (!(error instanceof NotFoundError) && !(error instanceof ForbiddenError)) throw error
    console.warn(`[reindex] project ${payload.projectId}: the requester no longer has access; stopping`)
    return { done: true, payload }
  }

  const { rows, nextCursor } = await listProjectDocumentPage(payload.projectId, session.organizationId, {
    authoredBy: 'user',
    cursor: payload.cursor ?? undefined,
    limit: REINDEX_SLICE_DOCUMENTS,
  })

  const counts: JobCounts = { ...payload.counts, failedNames: [...payload.counts.failedNames] }
  await forEachBounded(rows, REINDEX_CONCURRENCY, async (row) => {
    try {
      const outcome = await redispatchForReindex(session, row)
      counts[outcome] += 1
    } catch {
      // One document's failure must not abandon the rest of the project.
      recordFailure(counts, documentDisplayName(row))
    }
  })

  const next = { ...payload, cursor: nextCursor, counts }
  if (!nextCursor) logReindexSummary(next)
  return { done: !nextCursor, payload: next }
}

function logReindexSummary(payload: ReindexProjectPayload): void {
  const { queued, skipped, failed, failedNames } = payload.counts
  const line =
    `[reindex] project ${payload.projectId}: ${queued} re-dispatched, ${skipped} skipped, ${failed} failed` +
    (failed > 0 ? ` (${failedNames.join(', ')}${failed > failedNames.length ? ', …' : ''})` : '')
  // A failure is something an operator should see; a clean run is not.
  if (failed > 0) console.warn(line)
  else console.debug(line)
}

export interface ReingestFailedOrgResult {
  /** The job doing the work, on the `bff-jobs` pool (ADR-0081). */
  jobId: string
}

/** Failed documents one rescan slice sends back; see {@link REINDEX_SLICE_DOCUMENTS}. */
export const REINGEST_SLICE_DOCUMENTS = 25

function reingestRefusalCode(error: unknown): string | null {
  if (error instanceof ConflictError) {
    const details = error.details as { code?: unknown } | undefined
    return typeof details?.code === 'string' ? details.code : null
  }
  return null
}

/**
 * Re-dispatch every failed ingestion in the organization: authorize, then hand
 * the walk to a job.
 *
 * The rescan behind "Rescan failed ingestions" in Organization > Enterprise:
 * all files that were stored but could never be read (`failed`/`error`, plus
 * rows stranded at the `uploaded` birth status) go back through the ingest
 * pipeline under their own ids, so citations, chat subjects and assignments
 * pointing at them keep working.
 *
 * Like the reindex, the walk runs as a `bff-jobs` job (`reingest_failed`,
 * bulk), answered 202 with the job id. It pages through the failed set with a
 * keyset, so rows that stay failed cannot starve the rows behind them and the
 * job's whole state is one position. Each id still goes through
 * `reingestDocument`, so per-document access checks and the status guards stay
 * in exactly one place. Rows that are not retryable (still running, already
 * finished behind the row's back, not eligible, or no longer visible to the
 * requester) count as `skipped`, never as failures - and a dispatch that yields
 * no job resolves as `failed` rather than `queued`, because `dispatchIngest`
 * marks the row failed itself in that case. One document's failure never
 * abandons the rest.
 *
 * The rescan itself is audited (`org.documents.reingested`) with its outcome
 * when the job ends, because it is an organization-wide mutating admin action.
 */
export async function reingestFailedOrgDocuments(
  session: AuthorizedSession
): Promise<ReingestFailedOrgResult> {
  const open = await findOpenJobId({
    kind: 'reingest_failed',
    organizationId: session.organizationId,
    matching: {},
  })
  if (open) return { jobId: open }

  const payload: ReingestFailedPayload = {
    requester: requesterOf(session),
    cursor: null,
    counts: emptyCounts(),
  }
  const { jobId } = await enqueueJob({
    kind: 'reingest_failed',
    organizationId: session.organizationId,
    payload,
  })
  return { jobId }
}

/** How one failed document's retry came out. */
async function retryFailedDocument(
  session: AuthorizedSession,
  id: string
): Promise<'queued' | 'skipped' | 'failed'> {
  try {
    const outcome = await reingestDocument(session, id, { priority: 'bulk' })
    // No job id means the dispatch recorded the failure itself: the retry
    // went wrong, it did not queue.
    return outcome.status === 'failed' ? 'failed' : 'queued'
  } catch (error) {
    const code = reingestRefusalCode(error)
    if (code === INGEST_RUNNING || code === INGEST_ALREADY_DONE || code === INGEST_NOT_ELIGIBLE) return 'skipped'
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return 'skipped'
    return 'failed'
  }
}

/**
 * One slice of a `reingest_failed` job: the next page of the failed set, sent
 * back through ingestion, and the position to resume from. The audit event is
 * written by the slice that finds the end of the set.
 */
export async function runReingestFailedSlice(
  session: AuthorizedSession,
  payload: ReingestFailedPayload
): Promise<JobSliceResult<ReingestFailedPayload>> {
  // The route's own gate, asked again: the job may have waited, and the walk
  // spans slices. `session` is the requester's rights today (`handlers.ts`), so a
  // person who lost `org:settings:manage` since they clicked ends the rescan here.
  if (!hasPermission(session, ORG_PERMISSIONS.settingsManage)) {
    console.warn(`[reingest] ${session.userId} no longer holds ${ORG_PERMISSIONS.settingsManage}; stopping the rescan`)
    return { done: true, payload }
  }

  const { ids, nextCursor } = await listFailedDocumentPageInOrg(session.organizationId, {
    limit: REINGEST_SLICE_DOCUMENTS,
    cursor: payload.cursor,
  })

  const counts: JobCounts = { ...payload.counts, failedNames: [...payload.counts.failedNames] }
  await forEachBounded(ids, REINDEX_CONCURRENCY, async (id) => {
    const outcome = await retryFailedDocument(session, id)
    if (outcome === 'failed') recordFailure(counts, id)
    else counts[outcome] += 1
  })

  const next = { ...payload, cursor: nextCursor, counts }
  if (nextCursor) return { done: false, payload: next }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.documents.reingested',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: {
      total: counts.queued + counts.skipped + counts.failed,
      queued: counts.queued,
      skipped: counts.skipped,
      failed: counts.failed,
      truncated: false,
    },
  })
  return { done: true, payload: next }
}

/** How the sweep's retry of one stranded document came out. */
export type StuckDocumentOutcome = 'requeued' | 'failed' | 'gone'

/**
 * Give a document left at `processing` with no live job a new one, or say
 * plainly that it cannot have one.
 *
 * The sweep's door (`./stuck-processing`), and the system's own act: no person
 * is asking, so no session and no permission check; what the row says is all
 * this believes. It goes through {@link dispatchDocument}, so a model is parsed
 * again and an office file converted again by the same code a first upload
 * runs, the machine-authored guard included. A row there is nothing to rebuild
 * from (no stored bytes, not a person's document) is failed with the reason
 * the dispatcher gives for a failed start, because a row left at `processing`
 * would be found by every later sweep for good.
 */
export async function redispatchStuckDocument(
  organizationId: string,
  documentId: string
): Promise<StuckDocumentOutcome> {
  const doc = await findDocumentInOrg(documentId, organizationId)
  // Gone, or moved on since the sweep read it.
  if (!doc || doc.status !== 'processing') return 'gone'

  if (!doc.storageKey || doc.authoredBy !== 'user' || !collectionFileRef(doc)) {
    await markDocumentIngestFailed(doc.id, organizationId, INGEST_DISPATCH_FAILED_MESSAGE)
    return 'failed'
  }
  const { status } = await dispatchDocument({
    organizationId,
    projectId: doc.projectId,
    documentId: doc.id,
    filename: doc.filename,
    storageKey: doc.storageKey,
    storageBucket: doc.storageBucket,
    collectionName: doc.collectionName,
    folderPath: await resolveDocumentFolderPath(doc, organizationId),
    // Recovery is nobody's upload: it yields to the people who are waiting.
    priority: 'bulk',
  })
  return status === 'failed' ? 'failed' : 'requeued'
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
  tags: string[]
): Promise<{ id: string; tags: string[] }> {
  const doc = await getAccessibleDocument(session, documentId, 'write')

  const offending = tags.filter((tag) => !ALLOWED_TAGS.has(tag))
  if (offending.length > 0) {
    throw new BadRequestError('Tags outside the controlled vocabulary are not allowed', {
      invalidTags: offending,
    })
  }

  // The same gate as the read paths, on a WRITE. There is no backend summary row
  // for a document a machine wrote (never ingested), so the honest answer is the
  // 404 the backend itself gives for a non-colliding agent row — and the gate is
  // what makes the COLLIDING one answer the same way instead of overwriting the
  // controlled tags of the human document sharing the filename.
  const ref = collectionFileRef(doc)
  if (!ref) throw new NotFoundError()

  let res: Response
  try {
    res = await fetch(collectionFileUrl(getBackendUrl(), ref, '/tags'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
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
  request: Request
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
  //
  // Gated on authorship like every other `(collection, filename)` call: a
  // machine-authored row has no metadata row over there to mirror onto, and on a
  // filename collision this PATCH would retitle the HUMAN document's citation
  // chips — renaming one file would silently rename another. Skipping costs
  // nothing that is not already accepted here: the mirror is best-effort, and
  // the durable rename is the row written above.
  const mirrorRef = collectionFileRef(doc)
  if (mirrorRef) {
    try {
      await fetch(collectionFileUrl(getBackendUrl(), mirrorRef, '/display-title'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_title: displayName }),
        signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
      })
    } catch {
      // ignore — the durable rename is the row above; the chip catches up on the
      // next rename or the next re-ingestion.
    }
  }

  // Data-provenance event: who called which file what. Both names are
  // user-controlled, so both are capped before they reach the trail.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action:
      doc.scope === 'archiv' || doc.projectId === null
        ? 'archiv.document.renamed'
        : 'document.renamed',
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
 * owning project — the same permission the upload path checks. A legal hold on
 * the document, its project, its uploader or the organization refuses it with
 * a 409 before anything is erased (`@/lib/compliance/holds`). Mirrors
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
  request: Request
): Promise<void> {
  const doc = await findDocumentInOrg(documentId, session.organizationId)
  if (!doc || doc.scope !== 'project' || doc.projectId === null) throw new NotFoundError()

  await requireProjectAccess(session, doc.projectId, ['project:documents:write', 'project:edit'])
  // After the access check (an unauthorized caller learns nothing, not even
  // that a hold exists) and before the first destructive step below.
  await assertNoActiveHold(session.organizationId, 'document', documentId)

  // Best-effort: remove the ingested chunks so a deleted document stops showing
  // up in retrieval. A backend hiccup must not block the object and row
  // cleanup below, so it is recorded on the audit event rather than thrown.
  //
  // No ref → no chunks to purge, and this is where that mattered most. A
  // machine-authored row was never dispatched to `/v1/ingest`, so `file_ids:
  // [doc.filename]` names nothing of its own — and on the filename collision
  // `generatedFilename` makes reachable, it names a HUMAN document's chunks and
  // deletes them. That document keeps `status: 'completed'`, keeps its green
  // „zitierbar“ badge and its Ask affordance, and answers nothing from then on:
  // a silent, unlogged, unrecoverable content loss triggered by deleting an
  // unrelated file. The purge is skipped rather than made conditional on the
  // collision, because for an agent row it is ALWAYS wrong, collision or not.
  const purgeRef = collectionFileRef(doc)
  // `null`: nothing of its own to purge. `false`: the backend did not confirm,
  // and the audit row says so — the platform vector reconcile is the sweep.
  const chunksPurged = purgeRef
    ? await purgeIngestedChunks(getBackendUrl(), purgeRef, BACKEND_FETCH_TIMEOUT_MS)
    : null

  await eraseDocumentObjectsOrKeepRow(doc, session.organizationId)

  // Only once the bytes are gone. Grants and assignments are cheap to keep and
  // expensive to lose: a delete that stops at the object store above leaves a
  // document people can still open, and it should still be shared with them.
  await Promise.all([
    purgeResourceCollaboration('document', documentId).catch(() => undefined),
    deleteAssignmentsForResource(session.organizationId, 'document', documentId).catch(
      () => undefined
    ),
  ])

  await deleteProjectDocument(documentId, session.organizationId, doc.projectId)

  // Once more, now that the row is gone: an ingest of this document that
  // asked `GET /api/internal/document-exists` before the row went saw it,
  // and kept chunks it inserted after the first purge (ADR-0054, correction
  // 18). Any check from here on reads „gone“ and discards its own. Logged
  // inside, never thrown: the row is gone, and the orphan sweep is the net.
  if (purgeRef) await purgeIngestedChunks(getBackendUrl(), purgeRef, BACKEND_FETCH_TIMEOUT_MS)

  // Data-provenance event: who removed which file from which project.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.deleted',
    targetType: 'document',
    // Filename is user-controlled — cap it before it reaches the trail.
    metadata: {
      projectId: doc.projectId,
      filename: doc.filename.slice(0, 200),
      collectionName: doc.collectionName,
      chunksPurged,
    },
    request,
  })
}

export interface DocumentVisualDetail {
  page: number
  contentType: string
  drawingType: string
  scale: string
  text: string
  /**
   * Which depiction on the sheet this is. A sheet carrying a plan AND a section
   * is indexed as one chunk per depiction, so the page number alone no longer
   * identifies a row.
   */
  segment: number
  /**
   * How many depictions share this chunk's sheet. A sheet carrying two floor
   * plans side by side is indexed one chunk per depiction, so the preview
   * reads this to say which of the sheet's depictions a row is. `1` for
   * chunks indexed before per-segment chunking recorded it.
   */
  segmentCount: number
  /**
   * The structured analysis behind the description — entities, compositions,
   * quantities, provenance. `null` for chunks indexed before the structured
   * schema, and for backends that do not produce one.
   */
  structured: DrawingStructured | null
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
  documentId: string
): Promise<{ id: string; details: DocumentVisualDetail[] }> {
  const doc = await getAccessibleDocument(session, documentId, 'read')

  // A machine-authored row has no visual chunks — nothing it wrote was ever
  // ingested, so no page of it was ever described by the VLM. Asking anyway
  // returns, on a filename collision, ANOTHER document's extracted page text
  // rendered inside this row's detail panel. The empty list is the truth here,
  // and it is the same thing this function already answers for a backend that
  // has never heard of the file.
  const ref = collectionFileRef(doc)
  if (!ref) return { id: doc.id, details: [] }

  let res: Response
  try {
    res = await fetch(collectionFileUrl(getBackendUrl(), ref, '/visual-details'), {
      signal: AbortSignal.timeout(BACKEND_FETCH_TIMEOUT_MS),
    })
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
    segment: typeof d.segment === 'number' ? d.segment : 0,
    segmentCount: typeof d.segment_count === 'number' ? d.segment_count : 1,
    structured: normalizeDrawingStructured(d.structured),
  }))
  return { id: doc.id, details }
}

/** Presign a browser-facing download URL for a document. */
export async function getDocumentDownload(
  session: AuthorizedSession,
  documentId: string
): Promise<{
  downloadUrl: string
  filename: string
  contentType: string | null
  fileSize: number | null
}> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const downloadUrl = await getSignedUrl(
    signingS3Client,
    new GetObjectCommand({
      Bucket: resolveDocumentBucket(doc.storageBucket),
      Key: doc.storageKey,
      ResponseContentDisposition: contentDisposition('attachment', doc.filename),
    }),
    { expiresIn: presignTtlSeconds() }
  )

  return {
    downloadUrl,
    filename: doc.filename,
    contentType: doc.contentType,
    fileSize: doc.fileSize,
  }
}

/**
 * The key of an office document's PDF rendition, converting on first read
 * (ADR-0070), with the two failures mapped to what the routes answer.
 *
 * Lazy here because every office file uploaded before the conversion in
 * {@link beginRenditionIngest} existed has no rendition, nor does one whose
 * conversion failed there. "Disabled" is today's 415 exactly — a deployment without
 * `GOTENBERG_URL` must look as it did — and a converter failure is a 502 of its
 * own so the reader is told the preview failed rather than that the product
 * cannot show Word files.
 *
 * A person is waiting here, so the wait is bounded by
 * {@link RENDITION_READER_WAIT_MS} and a file whose conversion failed in the
 * last few minutes is answered as failed at once instead of converted again on
 * every open. The background ingest and its retry do not take that shortcut.
 */
async function officeRenditionKey(doc: Pick<Document, 'storageKey' | 'storageBucket' | 'filename'>, contentType: string): Promise<string> {
  const unsupported = () =>
    new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Preview not available for this file type', { contentType })
  if (!isRenditionEnabled() || !doc.storageKey) throw unsupported()
  try {
    return await ensureRendition(
      {
        bucket: resolveDocumentBucket(doc.storageBucket),
        storageKey: doc.storageKey,
        filename: doc.filename,
      },
      { readerWaitMs: RENDITION_READER_WAIT_MS }
    )
  } catch (error) {
    if (error instanceof RenditionUnavailableError) throw unsupported()
    if (error instanceof RenditionFailedError) {
      console.warn('[documents] office rendition failed:', error.message)
      throw new ApiError(502, 'RENDITION_FAILED', 'The PDF preview of this file could not be created')
    }
    throw error
  }
}

/** `Bericht.docx` → `Bericht.pdf`: the name a rendition is served under. */
function renditionFilename(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return `${dot > 0 ? filename.slice(0, dot) : filename}.pdf`
}

/**
 * Whether this row is served through its PDF rendition. A type the store can
 * already show inline wins, so a real PDF that happens to be named `.docx` is
 * still served as itself.
 */
function servedAsRendition(doc: Pick<Document, 'contentType' | 'filename'>): boolean {
  const contentType = doc.contentType || 'application/octet-stream'
  if (PREVIEW_CONTENT_TYPES.includes(contentType)) return false
  return isOfficeRenditionSource({ contentType: doc.contentType, filename: doc.filename })
}

export interface DocumentPreview {
  url: string
  /** What `url` serves: the stored type, or `application/pdf` for a rendition. */
  contentType: string
  filename: string
  imageUrl: string | null
  /** True when `url` is the PDF rendition of an office original (ADR-0070), not the stored bytes. */
  rendition: boolean
  /** The stored type of the original when `rendition` is true; null otherwise. */
  sourceContentType: string | null
}

/**
 * Presign a browser-facing inline preview URL. Non-previewable content types
 * are rejected with a 415. An office document is previewed through its PDF
 * rendition — the presigned URL is the rendition's, never the original's.
 */
export async function getDocumentPreview(
  session: AuthorizedSession,
  documentId: string
): Promise<DocumentPreview> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const contentType = doc.contentType || 'application/octet-stream'
  if (servedAsRendition(doc)) {
    const renditionKey = await officeRenditionKey(doc, contentType)
    const url = await getSignedUrl(
      signingS3Client,
      new GetObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: renditionKey,
        ResponseContentDisposition: contentDisposition('inline', renditionFilename(doc.filename)),
        ResponseContentType: 'application/pdf',
      }),
      { expiresIn: 3600 }
    )
    return {
      url,
      contentType: 'application/pdf',
      filename: doc.filename,
      imageUrl: null,
      rendition: true,
      sourceContentType: doc.contentType ?? null,
    }
  }

  if (!PREVIEW_CONTENT_TYPES.includes(contentType)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Preview not available for this file type', {
      contentType,
    })
  }

  const url = await getSignedUrl(
    signingS3Client,
    new GetObjectCommand({
      Bucket: resolveDocumentBucket(doc.storageBucket),
      Key: doc.storageKey,
      ResponseContentDisposition: contentDisposition('inline', doc.filename),
      ResponseContentType: contentType,
    }),
    { expiresIn: 3600 }
  )

  // A same-origin, signature-authorized path for the raster image formats the
  // optimizer can actually process — this is what lets `next/image` resize a
  // full-size upload down to the box it is rendered in. Null for PDFs, SVGs and
  // the exotic formats above, whose callers fall back to `url` unoptimized.
  const imageUrl = OPTIMIZABLE_IMAGE_CONTENT_TYPES.includes(contentType)
    ? buildDocumentImageUrl(session.organizationId, documentId, 'original')
    : null

  return { url, contentType, filename: doc.filename, imageUrl, rendition: false, sourceContentType: null }
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
 *
 * An office document streams its PDF RENDITION (ADR-0070), converted on first
 * read, so the viewer and the cited-passage highlight work on it exactly as on
 * a PDF. Still PDF only: what leaves this route is always a PDF the BFF made or
 * a PDF the user stored, never the office bytes themselves.
 */
export async function streamDocumentFile(
  session: AuthorizedSession,
  documentId: string
): Promise<Response> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const contentType = doc.contentType || 'application/octet-stream'
  let key = doc.storageKey
  let filename = doc.filename
  if (servedAsRendition(doc)) {
    key = await officeRenditionKey(doc, contentType)
    filename = renditionFilename(doc.filename)
  } else if (contentType !== 'application/pdf') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only PDF documents stream from this route', {
      contentType,
    })
  }

  let body
  try {
    const object = await s3Client.send(
      new GetObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: key,
      })
    )
    body = object.Body
  } catch {
    throw new NotFoundError('File not available')
  }
  if (!body) throw new NotFoundError('File not available')

  // ASCII-safe filename for the header; this route only ever displays inline.
  const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_')
  return new Response(body.transformToWebStream(), {
    status: 200,
    headers: {
      // Both branches above leave only a PDF to serve.
      'Content-Type': 'application/pdf',
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
 * A text document's content, for the pane that renders it.
 *
 * Bounded by {@link TEXT_PREVIEW_MAX_BYTES} and decoded the way the knowledge
 * layer reads the same bytes (`decodeTextBytes`: BOM, else strict UTF-8, else
 * Windows-1252). A Windows-authored `.csv` in cp1252 is common, and decoding it
 * as UTF-8 with replacement glyphs showed every umlaut as „�". `truncated` is part of the contract because a viewer that
 * silently shows the first half of a document is worse than one that shows none
 * of it — the reader would take the last line they see for the end of the file.
 */
export async function getDocumentTextPreview(
  session: AuthorizedSession,
  documentId: string
): Promise<{ text: string; truncated: boolean; contentType: string; filename: string }> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) throw new NotFoundError('File not available')

  const contentType = doc.contentType || 'application/octet-stream'
  if (!TEXT_PREVIEW_CONTENT_TYPES.includes(contentType)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Not a text document', { contentType })
  }

  let bytes: Uint8Array
  try {
    const object = await s3Client.send(
      new GetObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: doc.storageKey,
        // One byte past the cap, so a file sitting exactly on it is not reported
        // as truncated. Servers that ignore Range answer with the whole object,
        // which the slice below bounds anyway.
        Range: `bytes=0-${TEXT_PREVIEW_MAX_BYTES}`,
      })
    )
    if (!object.Body) throw new NotFoundError('File not available')
    bytes = await object.Body.transformToByteArray()
  } catch {
    throw new NotFoundError('File not available')
  }

  const truncated = bytes.byteLength > TEXT_PREVIEW_MAX_BYTES
  let { text } = decodeTextBytes(bytes.subarray(0, TEXT_PREVIEW_MAX_BYTES), { truncated })
  // A Range cut lands mid-line (and, in UTF-16, mid-character). Drop the
  // trailing partial line: a half-written last row of a CSV reads as data, and
  // the truncation notice below it is the honest statement.
  if (truncated) {
    const lastBreak = text.lastIndexOf('\n')
    if (lastBreak > 0) text = text.slice(0, lastBreak)
  }

  return { text, truncated, contentType, filename: doc.filename }
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
  documentId: string
): Promise<{ url: string | null }> {
  const doc = await getAccessibleDocument(session, documentId)
  if (!doc.storageKey) return { url: null }

  const thumbnailKey = buildThumbnailStorageKey(doc.storageKey)
  if (!thumbnailKey) return { url: null }

  // The signed same-origin URL is only useful if the JPEG actually exists.
  // Returning it blindly sent Next's image optimizer to a 404 / empty body
  // ("isn't a valid image … received null") for every file that is citable
  // but has no thumbnail yet (#366, #395).
  //
  // Existence is not enough: a failed ingest render can leave a 0-byte object
  // behind in the thumbnail slot, which passes HeadObject and then fails the
  // optimizer's decode — the same error, recurring for the same documents
  // across days. An empty object is no thumbnail.
  try {
    const head = await s3Client.send(
      new HeadObjectCommand({
        Bucket: resolveDocumentBucket(doc.storageBucket),
        Key: thumbnailKey,
      })
    )
    if ((head?.ContentLength ?? 0) <= 0) return { url: null }
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
      { expiresIn: 3600 }
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
  params: URLSearchParams
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
      new GetObjectCommand({ Bucket: resolveDocumentBucket(doc.storageBucket), Key: key })
    )
    // Mirror the mint-side guard: an object that truncated to 0 bytes between
    // the HEAD check and this GET (or reached here on a directly-shared signed
    // URL) decodes to nothing — serve the placeholder, not optimizer poison.
    if ((object?.ContentLength ?? 0) <= 0) throw new NotFoundError('Image not available')
    body = object.Body
  } catch (error) {
    // A document with no generated thumbnail lands here; the card reads the 404
    // as "no thumbnail" and shows its warm placeholder.
    if (error instanceof NotFoundError) throw error
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
  const [openVersion, [versionSummary]] = await Promise.all([
    findOpenVersion(reconciled.id, session.organizationId),
    listDocumentVersionSummaries([reconciled.id], session.organizationId),
  ])

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
    // The place in the ingest queue, null once the job is claimed or settled.
    queueAhead: reconciled.queueAhead ?? null,
    // Whose hand wrote the bytes. Added because this payload is how the CHAT
    // resolves a document into the peek pane, and a report Piloti wrote that
    // opens beside the conversation without its „Von Piloti erstellt" byline is
    // an agent-authored file presented as an uploaded one. PROVENANCE, never
    // responsibility — the row's assignees are unaffected and still say
    // `Unvergeben`.
    authoredBy: reconciled.authoredBy,
    // THE VERSION THE TURN WOULD HAVE TO READ AS BYTES.
    //
    // At most one version per document is still being worked on (the partial
    // unique index behind `findOpenVersion`), and that is precisely the version
    // retrieval cannot see: only a published version is dispatched to the index
    // (ADR-0054), so a draft has no chunks and the focus filter falls open to
    // the whole corpus. This payload is how the composer resolves its subject,
    // so it is where the two facts the turn needs — WHICH version and what state
    // it is in — belong. `null` means the live bytes are the published ones and
    // nothing extra has to travel.
    openVersion: openVersion ? { id: openVersion.id, state: openVersion.state } : null,
    // HOW MANY VERSIONS, so the chat peek can tell a failed re-upload from a
    // file that never indexed. A new version that fails to process leaves the
    // previous one's passages in the index — Piloti still cites it — and a
    // peek that said "cannot cite this file" for that case was wrong. The same
    // count the Files listing carries (`summarizeDocumentVersions`), for the
    // one document this payload is about. `null` when there is no version row
    // at all, which the peek reads as "no earlier version known".
    versionCount: versionSummary?.versionCount ?? null,
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
/**
 * Whether the document an ingest was dispatched for still exists — the
 * pipeline's question once a file is indexed, before it retires the previous
 * version (`GET /api/internal/document-exists`). A delete that landed while
 * the ingest ran leaves no row, and the pipeline then takes back out the
 * chunks it just inserted. Service-token caller, so no session to authorize.
 */
export async function documentStillExists(
  documentId: string,
  collectionName: string,
  organizationId?: string
): Promise<boolean> {
  return documentExistsInCollection(documentId, collectionName, organizationId)
}

/**
 * One presigned PUT slot for the `imageIndex`-th raster the ingest pipeline
 * cut out of a document, plus the key it will land on.
 *
 * Issued per image, on request, rather than as a batch in the ingest body:
 * how many rasters a PDF holds is unknown until extraction has run, most
 * documents hold none, and every pre-issued URL is a live write credential
 * that would ride along unused. The index is the only free variable —
 * `buildImageStorageKey` builds the key from the document's OWN storage key
 * and refuses an index at or past `MAX_STORED_IMAGES_PER_DOCUMENT`, which is
 * how the per-document ceiling is enforced: the backend stops at the first
 * refusal. Null when the document is unknown or the index is out of range.
 */
export async function presignDocumentImageUpload(
  documentId: string,
  collectionName: string,
  imageIndex: number,
  organizationId?: string
): Promise<{ uploadUrl: string; storageKey: string } | null> {
  const doc = await findStorageKeyByIdAndCollection(documentId, collectionName, organizationId)
  if (!doc) return null
  const storageKey = buildImageStorageKey(doc.storageKey, imageIndex)
  if (!storageKey) return null
  const uploadUrl = await presignForBackend(
    new PutObjectCommand({
      Bucket: resolveDocumentBucket(doc.storageBucket),
      Key: storageKey,
      ContentType: 'image/jpeg',
    }),
    3600
  )
  return { uploadUrl, storageKey }
}

/**
 * Where the `imageIndex`-th stored raster of a `(collection, filename)` pair
 * lives — the read half of {@link presignDocumentImageUpload}, for the
 * backend's `view_knowledge_image` tool. The key is built from the owning
 * document's row, never taken from the caller, so a derived read can only ever
 * name an object under that document's prefix. Null when the pair is unknown
 * or the index is out of range; the tool degrades to a text answer.
 */
export async function findDocumentImageStorageKey(
  collectionName: string,
  filename: string,
  imageIndex: number,
  organizationId?: string
): Promise<{ storageKey: string; storageBucket: string | null; contentType: string } | null> {
  const doc = await findStorageKeyByCollectionAndFilename(collectionName, filename, organizationId)
  if (!doc) return null
  const storageKey = buildImageStorageKey(doc.storageKey, imageIndex)
  if (!storageKey) return null
  return { storageKey, storageBucket: doc.storageBucket, contentType: 'image/jpeg' }
}

export async function findDocumentStorageKey(
  collectionName: string,
  filename: string,
  organizationId?: string
): Promise<{
  storageKey: string
  storageBucket: string | null
  contentType: string | null
} | null> {
  return findStorageKeyByCollectionAndFilename(collectionName, filename, organizationId)
}
