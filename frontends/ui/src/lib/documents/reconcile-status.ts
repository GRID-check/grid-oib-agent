/**
 * Server-side reconciliation of document ingestion status.
 *
 * The BFF upload route marks a document 'pending' after handing it to the
 * Python backend's `/v1/ingest` endpoint, but ingestion runs asynchronously
 * in the backend and nothing pushes the terminal state back into Postgres —
 * left alone, every uploaded document stays 'pending' forever. This module
 * closes the loop lazily: whenever document rows are read, in-flight rows are
 * checked against the backend ingestion job status (primary) or the
 * collection's file list (fallback for rows without a recorded job id, e.g.
 * uploads from before the job id was persisted, or after a backend restart
 * wiped the in-memory job registry) and terminal states are written back.
 */

import { onDocumentsSettled } from '@/lib/upload-batches/settle'
import { QUARANTINED_PREFIX } from '@/lib/upload-screening/quarantine'
import type { DocumentScreeningOutcome } from '@/lib/db/schema/documents'
import type { DocumentAuthor } from '@/lib/db/schema'
import { collectionFileRef, type CollectionFileRef } from './collection-file-ref'
import { IN_FLIGHT_DOCUMENT_STATUSES } from './document-status'
import { setDocumentReconciledStatus } from './repository'

/**
 * DB statuses that mean "ingestion outcome not yet known".
 *
 * Derived from the one declaration of the status vocabulary rather than listed
 * again here. The set used to be a literal, and it drifted from the badge's own
 * table by two values without anything failing — which is exactly how `stored`
 * could have been added to the column and quietly polled forever. A row that is
 * in this set is asked about on EVERY read, so a value that does not belong in
 * it (`stored`: no job was ever dispatched, so nothing will ever report on it)
 * costs a backend round trip per read and then overwrites the status from a
 * collection file list the document is not in — and, worse, MIGHT be in under
 * somebody else's row. `generatedFilename` builds a machine-authored row's name
 * from a title the model wrote, into the project's own collection, so that list
 * can hold the same filename belonging to a real upload. Reconciling from it
 * would write another document's ingestion outcome onto this row. The join is
 * gated on authorship for exactly that reason (see `./collection-file-ref`);
 * keeping `stored` out of this set is the cheaper half of the same rule.
 */
const IN_FLIGHT_STATUSES = IN_FLIGHT_DOCUMENT_STATUSES

/**
 * The one in-flight status the BACKEND cannot answer for. `processing` is
 * written by `markDocumentProcessing`, for work running in the BFF itself
 * (IFC extraction, office rendition) before any ingest job exists, and by a
 * Papierkorb restore for the documents its job is about to read again. Whatever the
 * row's metadata still carries is from the PREVIOUS dispatch: `metadata` is not
 * cleared when the row goes back to `processing`, so a retried document asks
 * the batch endpoint about its old failed job and flips back to `failed` while
 * the new conversion is still running; and a re-ingested document finds its
 * previous version `success` in the collection list and goes green before its
 * new bytes were read. The detached work writes every terminal outcome itself
 * (`pending` + job id on dispatch, `failed` otherwise), so the reconciler leaves
 * the status alone. A row stuck here because the process died is recovered by
 * the re-ingest action, which asks the backend live.
 */
const LOCALLY_OWNED_STATUS = 'processing'

/**
 * The reason prefix the backend gives a job whose owner stopped heartbeating
 * (`INTERRUPTED` in `aiq_agent/knowledge/ingest_status_store.py`). Such a
 * failure is a verdict another replica reached about someone else's job, and
 * the owner may still be alive: when it writes again its write wins, and the
 * job can end `completed` with its chunks indexed. A row the BFF already moved
 * to `failed` from that verdict is therefore asked about again.
 */
const INTERRUPTED_REASON_PREFIX = 'interrupted:'

/**
 * How long after the row's last write an `interrupted:` failure is re-checked.
 * An owner that revives does so within a heartbeat of reaching the database
 * again; half an hour covers a long outage and then stops, so a job that
 * really died costs a bounded number of batch lookups rather than one per read
 * for as long as the row exists.
 */
const INTERRUPTED_RECHECK_WINDOW_MS = 30 * 60 * 1000

const FETCH_TIMEOUT_MS = 5000

const getBackendUrl = (): string => {
  const url = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}

export interface ReconcilableDocument {
  id: string
  status: string
  filename: string
  collectionName: string
  /**
   * Whose hand wrote the bytes. REQUIRED, and the reason is this module's two
   * `(collectionName, filename)` joins: both address the backend's collection
   * file list, and a machine-authored row owns nothing in it (never dispatched
   * to `/v1/ingest`), so on a filename collision both would resolve to a human
   * document's state. `DocumentListRow` and `Document` have both carried the
   * column since migration 0063, so every existing caller already supplies it;
   * requiring it means a future row type that omits the `select` fails to
   * compile rather than silently reconciling as if a person had uploaded it.
   */
  authoredBy: DocumentAuthor
  /**
   * The version the item's storage columns mirror, or `null` (ADR-0054).
   *
   * REQUIRED for the same reason `authoredBy` is, and it became necessary the
   * day a machine-authored row could own backend state after all: a published
   * Piloti document HAS a file in the collection list and must be enriched from
   * it, while a draft of the same document still owns nothing. Authorship alone
   * can no longer tell those apart, so `collectionFileRef` asks both — and a row
   * type that cannot answer fails to compile rather than reconciling as if it
   * had.
   */
  publishedVersionId: string | null
  errorMessage: string | null
  metadata?: unknown
  /**
   * When the row was last written. Optional because it only sharpens the
   * metadata cache (a listing fetched before the row's last write cannot
   * describe that write — see `reconcileDocumentStatuses`); a row type that
   * leaves it out is enriched from the TTL cache exactly as before.
   */
  updatedAt?: Date | string | null
}

/**
 * Read-only document metadata surfaced from the backend's collection file list
 * and merged onto document rows for display. Every field is optional: a backend
 * outage, a missing file, or an ambiguous filename join all resolve to "absent"
 * rather than wrong data.
 */
export interface DocumentMetadata {
  summary?: string
  pageCount?: number
  chunkCount?: number
  contentTypes?: string[]
  /** Controlled ingestion-generated tags (document type + OIB discipline). */
  tags?: string[]
  /**
   * How many of this organisation's uploads wait in the ingest queue ahead of
   * this one (ADR-0076), or null when the row is not waiting there. The lane's
   * own order is the only one the queue promises, so no other office's backlog
   * is in the count. Set on every reconciled row, so a count shown once clears.
   */
  queueAhead?: number | null
}

interface TerminalResolution {
  status: 'completed' | 'failed' | 'quarantined'
  errorMessage: string | null
  /**
   * What the job's content gate concluded (ADR-0086), when it ran. Absent
   * leaves the column as it is: a job dispatched without screening (released,
   * or screening off) has nothing to say, and must not erase a `released`.
   */
  screeningOutcome?: DocumentScreeningOutcome
}

/**
 * What a re-checked `interrupted:` row may become: the backend's terminal
 * answer, or back to `pending` because the owner is still working. `pending`
 * and not `processing`, which is the status the BFF owns (see
 * {@link LOCALLY_OWNED_STATUS}); from `pending` the ordinary in-flight pass
 * takes over on the next read.
 */
type RowResolution = TerminalResolution | { status: 'pending'; errorMessage: null }

type JobResolution =
  | { kind: 'terminal'; resolution: TerminalResolution }
  | { kind: 'in_progress'; queueAhead: number | null }
  // Job unknown to the backend — fall back to the collection file list.
  | { kind: 'unknown' }

export const extractIngestJobId = (metadata: unknown): string | null => {
  if (metadata && typeof metadata === 'object' && 'ingestJobId' in metadata) {
    const jobId = (metadata as Record<string, unknown>).ingestJobId
    if (typeof jobId === 'string' && jobId.length > 0) return jobId
  }
  return null
}

/** The digest a dispatch recorded beside its job id (`setDocumentIngestJob`), or null. */
const recordedIngestHash = (metadata: unknown): string | null => {
  if (metadata && typeof metadata === 'object' && 'ingestContentHash' in metadata) {
    const hash = (metadata as Record<string, unknown>).ingestContentHash
    if (typeof hash === 'string' && hash.length > 0) return hash
  }
  return null
}

const fetchJson = async (url: string, init?: RequestInit): Promise<{ status: number; body: unknown } | null> => {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (response.status === 404) return { status: 404, body: null }
    if (!response.ok) return null
    return { status: response.status, body: await response.json() }
  } catch {
    return null
  }
}

interface BackendJobStatus {
  status?: string
  error_message?: string | null
  /** `queue_ahead`: the backend's count for a job still in the durable queue. */
  metadata?: { queue_ahead?: unknown } | null
  /** `screening`: the content gate's per-file outcome (ADR-0086), null when the job carried no rules. */
  file_details?: Array<{ status?: string; error_message?: string | null; screening?: string | null }>
}

/**
 * A failure the content gate reported is not a failure: the job stopped on
 * purpose, before any model call, and the row goes to quarantine (ADR-0086).
 */
const failedOrQuarantined = (errorMessage: string | null): TerminalResolution =>
  errorMessage?.startsWith(QUARANTINED_PREFIX)
    ? { status: 'quarantined', errorMessage, screeningOutcome: 'quarantined' }
    : { status: 'failed', errorMessage }

const SCREENING_OUTCOMES_FROM_JOB = new Set<DocumentScreeningOutcome>(['clean', 'partial', 'unchecked'])

/** The outcome a successful single-file job reports, when it screened at all. */
const completedOutcome = (job: BackendJobStatus): TerminalResolution => {
  const reported = job.file_details?.length === 1 ? job.file_details[0]?.screening : null
  const outcome = SCREENING_OUTCOMES_FROM_JOB.has(reported as DocumentScreeningOutcome)
    ? (reported as DocumentScreeningOutcome)
    : undefined
  return { status: 'completed', errorMessage: null, ...(outcome ? { screeningOutcome: outcome } : {}) }
}

/**
 * One POST for every in-flight job id instead of one GET per document.
 * A missing map entry / null value means the backend does not know the job
 * (→ collection-file-list fallback); a failed batch call skips reconciliation
 * for this round entirely.
 */
const fetchJobStatuses = async (jobIds: string[]): Promise<Map<string, BackendJobStatus | null> | null> => {
  if (jobIds.length === 0) return new Map()
  const result = await fetchJson(`${getBackendUrl()}/v1/documents/status/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_ids: jobIds }),
  })
  if (!result || result.status === 404 || typeof result.body !== 'object' || result.body === null) return null

  const statuses = (result.body as { statuses?: Record<string, BackendJobStatus | null> }).statuses ?? {}
  return new Map(Object.entries(statuses))
}

const resolveFromJobStatus = (job: BackendJobStatus | null | undefined): JobResolution => {
  if (job === undefined || job === null) return { kind: 'unknown' }

  if (job.status === 'completed') {
    // A single-file job can complete at the job level while its only file
    // failed; surface that as a failure rather than a false 'completed'.
    const failedFile = job.file_details?.find((f) => f.status === 'failed')
    if (failedFile && job.file_details?.length === 1) {
      return { kind: 'terminal', resolution: failedOrQuarantined(failedFile.error_message ?? null) }
    }
    return { kind: 'terminal', resolution: completedOutcome(job) }
  }
  if (job.status === 'failed') {
    const errorMessage = job.error_message ?? job.file_details?.find((f) => f.error_message)?.error_message ?? null
    return { kind: 'terminal', resolution: failedOrQuarantined(errorMessage) }
  }
  const ahead = job.metadata?.queue_ahead
  return { kind: 'in_progress', queueAhead: typeof ahead === 'number' && ahead >= 0 ? ahead : null }
}

/** One backend file entry, flattened to the fields the BFF forwards. */
interface BackendFileEntry {
  status?: string
  error_message?: string | null
  summary?: string | null
  chunk_count?: number
  page_count?: number
  content_types?: string[]
  tags?: string[] | null
}

/**
 * The backend collection file list, indexed by filename. `ambiguousNames`
 * carries filenames that appear more than once: the filename join is then
 * unsafe, so metadata for those is suppressed (show nothing over wrong data).
 */
interface CollectionFiles {
  byName: Map<string, BackendFileEntry>
  ambiguousNames: Set<string>
}

interface RawBackendFile {
  file_name?: string
  status?: string
  error_message?: string | null
  summary?: string | null
  chunk_count?: number
  // Tags are a top-level FileInfo field (not inside the internal metadata jsonb).
  tags?: string[] | null
  metadata?: { page_count?: number; content_types?: string[] } | null
}

const loadCollectionFiles = async (collectionName: string): Promise<CollectionFiles | null> => {
  const result = await fetchJson(
    `${getBackendUrl()}/v1/collections/${encodeURIComponent(collectionName)}/documents`
  )
  if (!result || result.status === 404 || !Array.isArray(result.body)) return null

  const byName = new Map<string, BackendFileEntry>()
  const ambiguousNames = new Set<string>()
  for (const file of result.body as RawBackendFile[]) {
    if (!file.file_name) continue
    if (byName.has(file.file_name)) {
      // Duplicate filename in the collection — the join is no longer 1:1.
      ambiguousNames.add(file.file_name)
      continue
    }
    byName.set(file.file_name, {
      status: file.status,
      error_message: file.error_message,
      summary: file.summary,
      chunk_count: file.chunk_count,
      page_count: file.metadata?.page_count,
      content_types: file.metadata?.content_types,
      tags: file.tags,
    })
  }
  return { byName, ambiguousNames }
}

// ---------------------------------------------------------------------------
// Short-TTL collection-file-list cache
//
// Metadata enrichment runs on EVERY document read. Without a cache, a read of a
// fully-terminal list still fetched every collection's file list from the
// backend — turning an otherwise zero-backend-call steady state into one fetch
// per collection per read. This module-level cache serves the enrichment of
// terminal rows: repeated reads within the TTL reuse a single fetch. In-flight
// status reconciliation deliberately bypasses it (status freshness cannot lag).
// ---------------------------------------------------------------------------

const COLLECTION_FILES_TTL_MS = 15_000

interface CollectionFilesCacheEntry {
  promise: Promise<CollectionFiles | null>
  /** When the fetch STARTED: the listing describes the backend at or after it. */
  fetchedAt: number
  expiresAt: number
}

const collectionFilesCache = new Map<string, CollectionFilesCacheEntry>()

/**
 * Store a fetch under the short TTL. A null (backend outage / 404) result is
 * evicted immediately so a transient failure never suppresses metadata for the
 * whole TTL window — the next read retries instead.
 */
const storeCollectionFiles = (collectionName: string, promise: Promise<CollectionFiles | null>): void => {
  const now = Date.now()
  collectionFilesCache.set(collectionName, { promise, fetchedAt: now, expiresAt: now + COLLECTION_FILES_TTL_MS })
  void promise.then((value) => {
    if (value === null && collectionFilesCache.get(collectionName)?.promise === promise) {
      collectionFilesCache.delete(collectionName)
    }
  })
}

/** TTL-cached read used for metadata enrichment (terminal rows). */
const loadCollectionFilesCached = (collectionName: string): Promise<CollectionFiles | null> => {
  const entry = collectionFilesCache.get(collectionName)
  if (entry && entry.expiresAt > Date.now()) return entry.promise
  const promise = loadCollectionFiles(collectionName)
  storeCollectionFiles(collectionName, promise)
  return promise
}

/** When the live cache entry for a collection was fetched, or null when there is none. */
const cachedListingFetchedAt = (collectionName: string): number | null => {
  const entry = collectionFilesCache.get(collectionName)
  return entry && entry.expiresAt > Date.now() ? entry.fetchedAt : null
}

/**
 * Fresh (TTL-bypassing) read, for status reconciliation from the list and for
 * enriching a row whose status just changed. It REPLACES the cache entry, so
 * every later read within the TTL sees the fresh listing too rather than the
 * one that predates the change.
 */
const loadCollectionFilesFresh = (collectionName: string): Promise<CollectionFiles | null> => {
  const promise = loadCollectionFiles(collectionName)
  storeCollectionFiles(collectionName, promise)
  return promise
}

/**
 * Invalidate the collection-file-list cache. Exported so tests can isolate TTL
 * behaviour between cases. Nothing in production needs it: a read that moves a
 * row to a terminal status enriches that collection from a fresh listing, which
 * replaces the entry (see `reconcileDocumentStatuses`).
 */
export const clearCollectionFilesCache = (): void => {
  collectionFilesCache.clear()
}

/**
 * Resolve an in-flight row's terminal status from the collection file list.
 *
 * Takes a {@link CollectionFileRef} rather than a filename, so it cannot be
 * called for a row a machine wrote: such a row has no entry of its own here,
 * and on a filename collision it would adopt the human document's `success` —
 * turning a never-dispatched row into a green, „zitierbar" one.
 *
 * A `failed` entry speaks only for a row that carries no job ({@link
 * attributableFailure}). `success` is the file's chunks under that name, and
 * stays the fallback for a job the backend has since forgotten.
 */
const resolveFromCollection = (
  files: CollectionFiles | null,
  ref: CollectionFileRef,
  jobId: string | null
): TerminalResolution | null => {
  const file = files?.byName.get(ref.filename)
  if (!file) return null
  if (file.status === 'success') return { status: 'completed', errorMessage: null }
  if (file.status === 'failed' && attributableFailure(jobId)) return failedOrQuarantined(file.error_message ?? null)
  return null
}

/**
 * Whether a `failed` entry of the collection file list is evidence about a row
 * with this job. Only when the row has none (a legacy row, or one dispatched
 * without a job id). The backend's failed entries are its per-upload tracking
 * records, joined here by NAME, and it lists the first of a name it still
 * tracks (`list_files` in the knowledge layer's adapter), so for a row that
 * carries a job the entry may be an EARLIER dispatch's: a released file's old
 * quarantine, written back over the new dispatch and recorded as a decision
 * that job never made (ADR-0086). The job is the only witness to its own
 * failure; a row whose job the backend forgot stays as it is.
 */
const attributableFailure = (jobId: string | null): boolean => jobId === null

/**
 * What the backend knows about one document's ingestion, asked live.
 *
 * The retry half of `reconcileDocumentStatuses`' read half: the reconciler
 * answers "what should this row SAY" on every listing read, this answers "is
 * anything still WORKING on it" at the moment a person asks to retry. Same
 * sources (job batch, then the collection file list), same authorship gate —
 * one implementation of what the backend knows, read two ways.
 *
 *  - `in-progress`: a job is running, or a file under this name is mid-flight.
 *    Retrying now would double the work, so the caller must refuse.
 *  - `terminal`: the backend finished but the row was never reconciled (a read
 *    has not landed since). The caller should persist this and NOT retry —
 *    re-dispatching a finished document churns the chunks citations point at.
 *  - `absent`: no job and no file. The backend has no record of this document
 *    — a restart wiped the job registry, or the detached IFC extraction died
 *    with the process — and retrying re-dispatches work that exists nowhere.
 *  - `unreachable`: the backend could not be asked. Fail-closed: the caller
 *    must refuse, because "unknown" is not "absent" and a retry now risks the
 *    double-dispatch `in-progress` exists to prevent.
 *
 * An ambiguous filename (two files, one name) reads as `in-progress`: the join
 * cannot attribute the file to this row, so retrying would be a guess about
 * someone else's ingestion.
 */
export type BackendIngestKnowledge =
  | { state: 'in-progress' }
  | { state: 'terminal'; resolution: TerminalResolution }
  | { state: 'absent' }
  | { state: 'unreachable' }

export async function describeBackendIngestState(row: {
  metadata?: unknown
  collectionName: string
  filename: string
  authoredBy: DocumentAuthor
  publishedVersionId: string | null
}): Promise<BackendIngestKnowledge> {
  const jobId = extractIngestJobId(row.metadata)
  if (jobId) {
    const statuses = await fetchJobStatuses([jobId])
    if (statuses === null) return { state: 'unreachable' }
    const result = resolveFromJobStatus(statuses.get(jobId))
    if (result.kind === 'terminal') return { state: 'terminal', resolution: result.resolution }
    if (result.kind === 'in_progress') return { state: 'in-progress' }
    // Unknown: the backend forgot the job (registry restart). Fall through to
    // the file list — the work may still have landed.
  }

  const ref = collectionFileRef(row)
  if (!ref) {
    // Nothing attributable in any collection list, and either no job or one
    // the backend already disowned above. For a machine-authored row that is
    // the expected shape (never dispatched); the dispatch guard, not this
    // function, decides whether it may ingest.
    return { state: 'absent' }
  }
  const files = await loadCollectionFilesFresh(row.collectionName)
  if (files === null) return { state: 'unreachable' }
  if (files.ambiguousNames.has(ref.filename)) return { state: 'in-progress' }
  const resolution = resolveFromCollection(files, ref, jobId)
  if (resolution) return { state: 'terminal', resolution }
  const file = files.byName.get(ref.filename)
  // A failure that is not this row's (`attributableFailure`) is no work in
  // progress either: nothing the backend knows of is this dispatch.
  if (file && !(file.status === 'failed' && !attributableFailure(jobId))) return { state: 'in-progress' }
  return { state: 'absent' }
}

/**
 * A `failed` row whose failure was the backend's `interrupted` settle, recent
 * enough to still be worth asking about, and with a job the batch call can
 * answer for. See {@link INTERRUPTED_REASON_PREFIX}. A row without `updatedAt`
 * is not re-checked: nothing would bound how long it keeps asking.
 */
const isRecheckableInterruption = (row: ReconcilableDocument, now: number): boolean => {
  if (row.status !== 'failed') return false
  if (!row.errorMessage?.startsWith(INTERRUPTED_REASON_PREFIX)) return false
  if (!extractIngestJobId(row.metadata)) return false
  const writtenAt = toEpochMs(row.updatedAt)
  return writtenAt !== null && now - writtenAt < INTERRUPTED_RECHECK_WINDOW_MS
}

/**
 * What the backend's answer about an interrupted job changes, or null for
 * nothing: a job that is still failed (or unknown) leaves the row as it is, so
 * a confirmed interruption costs no write.
 */
const resolveInterruptedRow = (job: BackendJobStatus | null | undefined): RowResolution | null => {
  const result = resolveFromJobStatus(job)
  if (result.kind === 'in_progress') return { status: 'pending', errorMessage: null }
  if (result.kind === 'terminal' && result.resolution.status === 'completed') return result.resolution
  return null
}

/**
 * Extract the curated, read-only metadata subset for a document from the backend
 * file list. Returns null (→ no enrichment) when the list is missing, the
 * filename is absent, or the join is ambiguous. Individual fields are omitted
 * when the backend did not provide them.
 *
 * Takes a {@link CollectionFileRef}, so a machine-authored row cannot reach it.
 * That row has no entry in this list of its own — it was never ingested — so
 * every field it could pick up here belongs to a HUMAN document whose filename
 * it happens to share, and `FileCard` renders `summary` with no gate. The result
 * was a real Gutachten's AI summary, page count and OIB tags displayed under a
 * „Von Piloti erstellt“ byline, and returned by
 * `GET /api/documents/{id}/status` to the chat peek pane.
 */
const toEpochMs = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

const extractMetadata = (files: CollectionFiles | null, ref: CollectionFileRef): DocumentMetadata | null => {
  if (!files || files.ambiguousNames.has(ref.filename)) return null
  const file = files.byName.get(ref.filename)
  if (!file) return null

  const meta: DocumentMetadata = {}
  if (typeof file.summary === 'string' && file.summary.length > 0) meta.summary = file.summary
  if (typeof file.page_count === 'number' && file.page_count > 0) meta.pageCount = file.page_count
  if (typeof file.chunk_count === 'number' && file.chunk_count > 0) meta.chunkCount = file.chunk_count
  if (Array.isArray(file.content_types) && file.content_types.length > 0) {
    meta.contentTypes = file.content_types
  }
  if (Array.isArray(file.tags) && file.tags.length > 0) {
    meta.tags = file.tags.filter((t): t is string => typeof t === 'string')
  }
  return Object.keys(meta).length > 0 ? meta : null
}

/**
 * Reconcile in-flight document rows with the backend's ingestion state and
 * persist any terminal transition (and re-check a recent `interrupted:`
 * failure, see {@link INTERRUPTED_REASON_PREFIX}), then merge the backend's read-only document
 * metadata (summary, page/chunk counts, content types) onto every returned row.
 *
 * Returns the rows with fresh statuses and metadata; rows that are already
 * terminal (or still genuinely in flight) keep their status, and metadata is
 * layered on top. Backend outages never fail the read path — a failed fetch
 * simply leaves statuses untouched and metadata absent until the next read.
 *
 * BOTH passes join on `(collectionName, filename)`, and both go through
 * {@link collectionFileRef} first: a row a machine wrote owns nothing under that
 * pair, so it gets neither a status nor metadata from it. The status pass used
 * to be safe only by accident — filing writes `stored`, which is not in
 * {@link IN_FLIGHT_STATUSES} — which is a fact about the STATUS column, not
 * about authorship; the enrichment pass had no gate at all and leaked a human
 * document's summary onto an agent row's card on every read.
 */
export async function reconcileDocumentStatuses<T extends ReconcilableDocument>(
  rows: T[],
  organizationId: string,
): Promise<Array<T & DocumentMetadata>> {
  if (rows.length === 0) return []

  // Per-call dedup for FRESH fetches: at most one per collection per read,
  // shared by the status pass and the enrichment pass. Each also replaces the
  // module-level cache entry (via loadCollectionFilesFresh).
  const freshFetches = new Map<string, Promise<CollectionFiles | null>>()
  const getFreshCollectionFiles = (collectionName: string): Promise<CollectionFiles | null> => {
    let cached = freshFetches.get(collectionName)
    if (!cached) {
      cached = loadCollectionFilesFresh(collectionName)
      freshFetches.set(collectionName, cached)
    }
    return cached
  }

  // --- Status reconciliation (in-flight rows, and recent interrupted failures) ---
  const resolutions = new Map<string, RowResolution>()
  // The rows THIS read moved. A row another read moved first still reports
  // its new status, but settles once, in the read whose write landed.
  const moved = new Set<string>()
  const queueAheadByRow = new Map<string, number>()
  const inFlight = rows.filter(
    (row) => IN_FLIGHT_STATUSES.has(row.status) && row.status !== LOCALLY_OWNED_STATUS
  )
  const now = Date.now()
  const interrupted = rows.filter((row) => isRecheckableInterruption(row, now))
  if (inFlight.length > 0 || interrupted.length > 0) {
    // One batch call for every job id asked about (previously one GET per row).
    const jobIds = [
      ...new Set(
        [...inFlight, ...interrupted]
          .map((row) => extractIngestJobId(row.metadata))
          .filter((id): id is string => !!id)
      ),
    ]
    const jobStatuses = await fetchJobStatuses(jobIds)

    // An interrupted row is healed from its job alone. The collection file
    // list is no evidence about THIS dispatch: a previous version's `success`
    // would turn a real failure green.
    await Promise.all(
      interrupted.map(async (row) => {
        const jobId = extractIngestJobId(row.metadata)
        if (jobStatuses === null || !jobId) return
        const resolution = resolveInterruptedRow(jobStatuses.get(jobId))
        if (!resolution) return
        if (await setDocumentReconciledStatus(row.id, organizationId, resolution, { status: row.status, jobId })) {
          moved.add(row.id)
        }
        resolutions.set(row.id, resolution)
      })
    )

    await Promise.all(
      inFlight.map(async (row) => {
        const jobId = extractIngestJobId(row.metadata)
        let resolution: TerminalResolution | null = null

        if (jobId) {
          // Batch call failed → backend unreachable → leave rows untouched.
          if (jobStatuses === null) return
          const jobResult = resolveFromJobStatus(jobStatuses.get(jobId))
          if (jobResult.kind === 'terminal') {
            resolution = jobResult.resolution
          } else if (jobResult.kind === 'in_progress') {
            // Nothing to write this round; only the place in the queue to show.
            if (jobResult.queueAhead !== null) queueAheadByRow.set(row.id, jobResult.queueAhead)
            return
          }
        }

        if (!resolution) {
          // No ref → nothing of this row's exists in that collection; see
          // `resolveFromCollection`. An in-flight machine-authored row is
          // already an anomaly (filing writes `stored`, which is terminal), and
          // the honest outcome for it is "unchanged", not another document's.
          const ref = collectionFileRef(row)
          if (!ref) return
          resolution = resolveFromCollection(await getFreshCollectionFiles(row.collectionName), ref, jobId)
        }
        if (!resolution) return

        if (await setDocumentReconciledStatus(row.id, organizationId, resolution, { status: row.status, jobId })) {
          moved.add(row.id)
        }
        resolutions.set(row.id, resolution)
      })
    )
  }

  // Rows that came to rest settle their upload, audit a quarantine and tell
  // its reviewers (ADR-0086). Only the rows this read moved: a concurrent read
  // that lost the race settles nothing. Never throws. A quarantine whose audit
  // event did not go out stays owed in `document_quarantine_decisions`, and the
  // upload sweep sends it; a batch left open is the sweep's too.
  const settled = [...resolutions].filter(([id, resolution]) => moved.has(id) && resolution.status !== 'pending')
  if (settled.length > 0) {
    await onDocumentsSettled(
      organizationId,
      settled.map(([id, resolution]) => ({ id, status: resolution.status }))
    )
  }

  // --- Metadata enrichment (all rows) ---
  // Steady state reads the short-TTL cache: a read where every row is terminal
  // and unchanged makes zero backend calls within the TTL. Two cases read a
  // FRESH listing instead, because the cached one cannot describe them:
  //
  //  - a row this read moved to a terminal status. The job batch said
  //    `completed`, but the listing in the cache may be from before the file
  //    or its summary existed, and this is the read that tells every client to
  //    stop polling. Enriching it from that listing meant the first (and last)
  //    `completed` a client saw carried no summary, counts or tags.
  //  - a row written after the cached listing was fetched (`updatedAt`). A
  //    transition written by ANOTHER read, or by the re-ingest heal, lands here
  //    once and then not again: the fresh fetch is newer than the write.
  //
  // Fail-open throughout: a null file list (backend down / 404) yields no
  // metadata.
  const collectionsNeedingFresh = new Set<string>()
  for (const row of rows) {
    if (freshFetches.has(row.collectionName)) continue
    if (resolutions.has(row.id)) {
      collectionsNeedingFresh.add(row.collectionName)
      continue
    }
    if (IN_FLIGHT_STATUSES.has(row.status)) continue
    const fetchedAt = cachedListingFetchedAt(row.collectionName)
    const writtenAt = toEpochMs(row.updatedAt)
    if (fetchedAt !== null && writtenAt !== null && writtenAt > fetchedAt) {
      collectionsNeedingFresh.add(row.collectionName)
    }
  }

  const listingFor = (collectionName: string): Promise<CollectionFiles | null> =>
    freshFetches.has(collectionName) || collectionsNeedingFresh.has(collectionName)
      ? getFreshCollectionFiles(collectionName)
      : loadCollectionFilesCached(collectionName)

  const metaByRow = new Map<string, DocumentMetadata>()
  await Promise.all(
    rows.map(async (row) => {
      // The authorship gate, ahead of the fetch. A machine-authored row is not
      // enriched AND does not cost a collection listing to decide that — it
      // owns nothing in the list either way.
      const ref = collectionFileRef(row)
      if (!ref) return
      const meta = extractMetadata(await listingFor(row.collectionName), ref)
      if (meta) metaByRow.set(row.id, meta)
    })
  )

  return rows.map((row) => {
    const resolution = resolutions.get(row.id)
    const meta = metaByRow.get(row.id) ?? {}
    // The verdict travels with the status, on a row that carries one, so a
    // listing that narrows after this read (`keepReadable`) reads the new one.
    const verdict =
      resolution && 'screeningOutcome' in resolution && resolution.screeningOutcome && 'screeningOutcome' in row
        ? { screeningOutcome: resolution.screeningOutcome }
        : {}
    // And the bytes it judged, as `setDocumentReconciledStatus` writes them
    // (migration 0123): the digest the dispatch recorded.
    const dispatchedHash = recordedIngestHash(row.metadata)
    const judged =
      resolution?.status === 'completed' && 'screenedHash' in row && dispatchedHash !== null
        ? { screenedHash: dispatchedHash }
        : {}
    const base = resolution
      ? { ...row, status: resolution.status, errorMessage: resolution.errorMessage, ...verdict, ...judged }
      : row
    return { ...base, ...meta, queueAhead: queueAheadByRow.get(row.id) ?? null }
  })
}
