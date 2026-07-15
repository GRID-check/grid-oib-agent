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

import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'

/** DB statuses that mean "ingestion outcome not yet known". */
const IN_FLIGHT_STATUSES = new Set(['pending', 'processing', 'ingesting'])

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
  errorMessage: string | null
  metadata?: unknown
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
}

interface TerminalResolution {
  status: 'completed' | 'failed'
  errorMessage: string | null
}

type JobResolution =
  | { kind: 'terminal'; resolution: TerminalResolution }
  | { kind: 'in_progress' }
  // Job unknown to the backend — fall back to the collection file list.
  | { kind: 'unknown' }

export const extractIngestJobId = (metadata: unknown): string | null => {
  if (metadata && typeof metadata === 'object' && 'ingestJobId' in metadata) {
    const jobId = (metadata as Record<string, unknown>).ingestJobId
    if (typeof jobId === 'string' && jobId.length > 0) return jobId
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
  file_details?: Array<{ status?: string; error_message?: string | null }>
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
      return {
        kind: 'terminal',
        resolution: { status: 'failed', errorMessage: failedFile.error_message ?? null },
      }
    }
    return { kind: 'terminal', resolution: { status: 'completed', errorMessage: null } }
  }
  if (job.status === 'failed') {
    const errorMessage = job.error_message ?? job.file_details?.find((f) => f.error_message)?.error_message ?? null
    return { kind: 'terminal', resolution: { status: 'failed', errorMessage } }
  }
  return { kind: 'in_progress' }
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
  expiresAt: number
}

const collectionFilesCache = new Map<string, CollectionFilesCacheEntry>()

/**
 * Store a fetch under the short TTL. A null (backend outage / 404) result is
 * evicted immediately so a transient failure never suppresses metadata for the
 * whole TTL window — the next read retries instead.
 */
const storeCollectionFiles = (collectionName: string, promise: Promise<CollectionFiles | null>): void => {
  collectionFilesCache.set(collectionName, { promise, expiresAt: Date.now() + COLLECTION_FILES_TTL_MS })
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

/**
 * Fresh (TTL-bypassing) read used by in-flight status reconciliation, where the
 * status must reflect the very latest backend state. It also primes the cache so
 * the enrichment pass in the same read reuses this fetch rather than issuing a
 * second one.
 */
const loadCollectionFilesFresh = (collectionName: string): Promise<CollectionFiles | null> => {
  const promise = loadCollectionFiles(collectionName)
  storeCollectionFiles(collectionName, promise)
  return promise
}

/**
 * Invalidate the collection-file-list cache. Exported primarily so tests can
 * isolate TTL behaviour between cases. (The pending→terminal transition itself
 * is detected via a fresh fetch that re-primes the cache, so a document
 * completing is already reflected without an explicit clear; hence no
 * upload-completion caller is wired here — TTL expiry covers the rest.)
 */
export const clearCollectionFilesCache = (): void => {
  collectionFilesCache.clear()
}

const resolveFromCollection = (
  files: CollectionFiles | null,
  filename: string
): TerminalResolution | null => {
  const file = files?.byName.get(filename)
  if (!file) return null
  if (file.status === 'success') return { status: 'completed', errorMessage: null }
  if (file.status === 'failed') return { status: 'failed', errorMessage: file.error_message ?? null }
  return null
}

/**
 * Extract the curated, read-only metadata subset for a filename from the
 * backend file list. Returns null (→ no enrichment) when the list is missing,
 * the filename is absent, or the join is ambiguous. Individual fields are
 * omitted when the backend did not provide them.
 */
const extractMetadata = (files: CollectionFiles | null, filename: string): DocumentMetadata | null => {
  if (!files || files.ambiguousNames.has(filename)) return null
  const file = files.byName.get(filename)
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
 * persist any terminal transition, then merge the backend's read-only document
 * metadata (summary, page/chunk counts, content types) onto every returned row.
 *
 * Returns the rows with fresh statuses and metadata; rows that are already
 * terminal (or still genuinely in flight) keep their status, and metadata is
 * layered on top. Backend outages never fail the read path — a failed fetch
 * simply leaves statuses untouched and metadata absent until the next read.
 */
export async function reconcileDocumentStatuses<T extends ReconcilableDocument>(
  rows: T[]
): Promise<Array<T & DocumentMetadata>> {
  if (rows.length === 0) return []

  const db = getDb()
  // Per-call dedup for FRESH fetches used by status reconciliation: multiple
  // in-flight rows in the same collection share one fetch. Each fresh fetch also
  // primes the module-level TTL cache (via loadCollectionFilesFresh), so the
  // enrichment pass below reuses it instead of fetching again.
  const freshFetches = new Map<string, Promise<CollectionFiles | null>>()
  const getFreshCollectionFiles = (collectionName: string): Promise<CollectionFiles | null> => {
    let cached = freshFetches.get(collectionName)
    if (!cached) {
      cached = loadCollectionFilesFresh(collectionName)
      freshFetches.set(collectionName, cached)
    }
    return cached
  }

  // --- Status reconciliation (in-flight rows only) ---
  const resolutions = new Map<string, TerminalResolution>()
  const inFlight = rows.filter((row) => IN_FLIGHT_STATUSES.has(row.status))
  if (inFlight.length > 0) {
    // One batch call for every in-flight job id (previously one GET per row).
    const jobIds = [
      ...new Set(inFlight.map((row) => extractIngestJobId(row.metadata)).filter((id): id is string => !!id)),
    ]
    const jobStatuses = await fetchJobStatuses(jobIds)

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
          } else if (jobResult.kind !== 'unknown') {
            // in_progress — nothing to write this round.
            return
          }
        }

        if (!resolution) {
          resolution = resolveFromCollection(await getFreshCollectionFiles(row.collectionName), row.filename)
        }
        if (!resolution) return

        await db
          .update(documents)
          .set({
            status: resolution.status,
            errorMessage: resolution.errorMessage,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, row.id))
        resolutions.set(row.id, resolution)
      })
    )
  }

  // --- Metadata enrichment (all rows) ---
  // Completed documents never hit the status pass above, so metadata is joined
  // here for every row via the short-TTL cache. Collections that were consulted
  // fresh during status reconciliation are already primed (no double fetch);
  // a read where every row is terminal reuses the cache and — within the TTL —
  // makes zero backend calls, restoring the zero-call steady state. Fail-open:
  // a null file list (backend down / 404) simply yields no metadata.
  const metaByRow = new Map<string, DocumentMetadata>()
  await Promise.all(
    rows.map(async (row) => {
      const meta = extractMetadata(await loadCollectionFilesCached(row.collectionName), row.filename)
      if (meta) metaByRow.set(row.id, meta)
    })
  )

  return rows.map((row) => {
    const resolution = resolutions.get(row.id)
    const meta = metaByRow.get(row.id) ?? {}
    const base = resolution
      ? { ...row, status: resolution.status, errorMessage: resolution.errorMessage }
      : row
    return { ...base, ...meta }
  })
}
