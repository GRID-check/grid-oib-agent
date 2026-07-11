/**
 * Knowledge-base service — read-only transparency over the RAG corpus.
 *
 * Fetches the merged OIB corpus report from the Python backend
 * (`GET /v1/oib/status`) and maps it to the camelCase shape the UI consumes.
 * A dedicated service (instead of the generic `/api/v1` proxy) is required
 * because the proxy's collection authz deliberately rejects any request that
 * names the base corpus collection.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'
import { UpstreamError } from '@/lib/api/errors'

/** Lifecycle of a corpus file relative to what the RAG has indexed. */
export type KnowledgeFileState = 'ingested' | 'stale' | 'pending' | 'removed' | 'inconsistent'

export interface KnowledgeFile {
  fileName: string
  state: KnowledgeFileState
  sizeBytes: number | null
  chunkCount: number
  ingestedSha256: string | null
  currentSha256: string | null
  ingestedAt: string | null
  summary: string | null
}

export interface KnowledgeBaseSummary {
  totalFiles: number
  ingested: number
  stale: number
  pending: number
  removed: number
  inconsistent: number
  totalChunks: number
}

export interface KnowledgeBaseStatus {
  collectionName: string
  collectionExists: boolean
  collectionUpdatedAt: string | null
  summary: KnowledgeBaseSummary
  files: KnowledgeFile[]
}

const KNOWLEDGE_STATUS_TIMEOUT_MS = 30_000

interface BackendFileEntry {
  file_name?: unknown
  state?: unknown
  size_bytes?: unknown
  chunk_count?: unknown
  ingested_sha256?: unknown
  current_sha256?: unknown
  ingested_at?: unknown
  summary?: unknown
}

const FILE_STATES: KnowledgeFileState[] = ['ingested', 'stale', 'pending', 'removed', 'inconsistent']

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function mapFile(entry: BackendFileEntry): KnowledgeFile {
  const state = FILE_STATES.includes(entry.state as KnowledgeFileState)
    ? (entry.state as KnowledgeFileState)
    : 'pending'
  return {
    fileName: asString(entry.file_name) ?? 'unknown',
    state,
    sizeBytes: typeof entry.size_bytes === 'number' ? entry.size_bytes : null,
    chunkCount: asCount(entry.chunk_count),
    ingestedSha256: asString(entry.ingested_sha256),
    currentSha256: asString(entry.current_sha256),
    ingestedAt: asString(entry.ingested_at),
    summary: asString(entry.summary),
  }
}

/**
 * Fetch the OIB corpus status from the backend. Read-only; every
 * authenticated user may see it — the corpus is the shared, non-tenant
 * regulatory knowledge every chat answer is grounded on.
 */
export async function getKnowledgeBaseStatus(): Promise<KnowledgeBaseStatus> {
  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/oib/status`, {
      signal: AbortSignal.timeout(KNOWLEDGE_STATUS_TIMEOUT_MS),
    })
  } catch (error) {
    throw new UpstreamError('Knowledge backend unreachable', error instanceof Error ? error.message : undefined)
  }
  if (!res.ok) {
    throw new UpstreamError(`Knowledge backend returned ${res.status}`)
  }

  const body = await res.json().catch(() => {
    throw new UpstreamError('Knowledge backend returned malformed JSON')
  })

  const summary = body?.summary ?? {}
  const files = Array.isArray(body?.files) ? body.files : []

  return {
    collectionName: asString(body?.collection_name) ?? '',
    collectionExists: body?.collection_exists === true,
    collectionUpdatedAt: asString(body?.collection_updated_at),
    summary: {
      totalFiles: asCount(summary.total_files),
      ingested: asCount(summary.ingested),
      stale: asCount(summary.stale),
      pending: asCount(summary.pending),
      removed: asCount(summary.removed),
      inconsistent: asCount(summary.inconsistent),
      totalChunks: asCount(summary.total_chunks),
    },
    files: files.map(mapFile),
  }
}
