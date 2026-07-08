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

interface TerminalResolution {
  status: 'completed' | 'failed'
  errorMessage: string | null
}

type JobResolution =
  | { kind: 'terminal'; resolution: TerminalResolution }
  | { kind: 'in_progress' }
  // Job unknown to the backend (404) — fall back to the collection file list.
  | { kind: 'unknown' }
  // Backend unreachable or errored — leave the row untouched this round.
  | { kind: 'skip' }

export const extractIngestJobId = (metadata: unknown): string | null => {
  if (metadata && typeof metadata === 'object' && 'ingestJobId' in metadata) {
    const jobId = (metadata as Record<string, unknown>).ingestJobId
    if (typeof jobId === 'string' && jobId.length > 0) return jobId
  }
  return null
}

const fetchJson = async (url: string): Promise<{ status: number; body: unknown } | null> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (response.status === 404) return { status: 404, body: null }
    if (!response.ok) return null
    return { status: response.status, body: await response.json() }
  } catch {
    return null
  }
}

const resolveFromJob = async (jobId: string): Promise<JobResolution> => {
  const result = await fetchJson(`${getBackendUrl()}/v1/documents/${encodeURIComponent(jobId)}/status`)
  if (!result) return { kind: 'skip' }
  if (result.status === 404) return { kind: 'unknown' }

  const job = result.body as {
    status?: string
    error_message?: string | null
    file_details?: Array<{ status?: string; error_message?: string | null }>
  }

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

type CollectionFiles = Map<string, { status?: string; error_message?: string | null }>

const loadCollectionFiles = async (collectionName: string): Promise<CollectionFiles | null> => {
  const result = await fetchJson(
    `${getBackendUrl()}/v1/collections/${encodeURIComponent(collectionName)}/documents`
  )
  if (!result || result.status === 404 || !Array.isArray(result.body)) return null

  const files: CollectionFiles = new Map()
  for (const file of result.body as Array<{ file_name?: string; status?: string; error_message?: string | null }>) {
    if (file.file_name) files.set(file.file_name, file)
  }
  return files
}

const resolveFromCollection = (
  files: CollectionFiles | null,
  filename: string
): TerminalResolution | null => {
  const file = files?.get(filename)
  if (!file) return null
  if (file.status === 'success') return { status: 'completed', errorMessage: null }
  if (file.status === 'failed') return { status: 'failed', errorMessage: file.error_message ?? null }
  return null
}

/**
 * Reconcile in-flight document rows with the backend's ingestion state and
 * persist any terminal transition. Returns the rows with fresh statuses;
 * rows that are already terminal (or still genuinely in flight) pass through
 * unchanged. Backend outages never fail the read path — rows are simply left
 * as they are until the next read.
 */
export async function reconcileDocumentStatuses<T extends ReconcilableDocument>(rows: T[]): Promise<T[]> {
  const inFlight = rows.filter((row) => IN_FLIGHT_STATUSES.has(row.status))
  if (inFlight.length === 0) return rows

  const db = getDb()
  // One file-list fetch per collection, shared across rows in this call.
  const collectionCache = new Map<string, Promise<CollectionFiles | null>>()
  const getCollectionFiles = (collectionName: string): Promise<CollectionFiles | null> => {
    let cached = collectionCache.get(collectionName)
    if (!cached) {
      cached = loadCollectionFiles(collectionName)
      collectionCache.set(collectionName, cached)
    }
    return cached
  }

  const resolutions = new Map<string, TerminalResolution>()

  await Promise.all(
    inFlight.map(async (row) => {
      const jobId = extractIngestJobId(row.metadata)
      let resolution: TerminalResolution | null = null

      if (jobId) {
        const jobResult = await resolveFromJob(jobId)
        if (jobResult.kind === 'terminal') {
          resolution = jobResult.resolution
        } else if (jobResult.kind !== 'unknown') {
          // in_progress or backend unreachable — nothing to write this round.
          return
        }
      }

      if (!resolution) {
        resolution = resolveFromCollection(await getCollectionFiles(row.collectionName), row.filename)
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

  if (resolutions.size === 0) return rows
  return rows.map((row) => {
    const resolution = resolutions.get(row.id)
    return resolution ? { ...row, status: resolution.status, errorMessage: resolution.errorMessage } : row
  })
}
