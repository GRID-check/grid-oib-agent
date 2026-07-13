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
import { BadRequestError, NotFoundError, UpstreamError } from '@/lib/api/errors'

/** Lifecycle of a corpus file relative to what the RAG has indexed. */
export type KnowledgeFileState = 'ingested' | 'stale' | 'pending' | 'snapshot' | 'removed' | 'inconsistent'

/** Where the file's source lives: repo corpus, admin upload, or index-only. */
export type KnowledgeFileOrigin = 'corpus' | 'uploaded' | 'index_only'

export interface KnowledgeFile {
  fileName: string
  state: KnowledgeFileState
  origin: KnowledgeFileOrigin
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
  snapshot: number
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
  origin?: unknown
  size_bytes?: unknown
  chunk_count?: unknown
  ingested_sha256?: unknown
  current_sha256?: unknown
  ingested_at?: unknown
  summary?: unknown
}

const FILE_STATES: KnowledgeFileState[] = ['ingested', 'stale', 'pending', 'snapshot', 'removed', 'inconsistent']
const FILE_ORIGINS: KnowledgeFileOrigin[] = ['corpus', 'uploaded', 'index_only']

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
  const origin = FILE_ORIGINS.includes(entry.origin as KnowledgeFileOrigin)
    ? (entry.origin as KnowledgeFileOrigin)
    : 'index_only'
  return {
    fileName: asString(entry.file_name) ?? 'unknown',
    state,
    origin,
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
      snapshot: asCount(summary.snapshot),
      removed: asCount(summary.removed),
      inconsistent: asCount(summary.inconsistent),
      totalChunks: asCount(summary.total_chunks),
    },
    files: files.map(mapFile),
  }
}

/**
 * Admin-token header for the backend's `/v1/admin/oib/*` endpoints. The token
 * is optional in dev (the backend fails open when its own token is unset);
 * production deployments must set GRID_ADMIN_TOKEN on both services.
 */
function adminHeaders(): Record<string, string> {
  const token = process.env.GRID_ADMIN_TOKEN
  return token ? { 'X-Admin-Token': token } : {}
}

/** Basename-only, `.pdf`-only — anything else is rejected before it travels. */
function requirePdfBasename(fileName: string): string {
  const name = fileName.trim()
  if (!name || name !== name.replace(/[/\\]/g, '') || !name.toLowerCase().endsWith('.pdf')) {
    throw new BadRequestError('A .pdf file name without path segments is required')
  }
  return name
}

export interface KnowledgeUploadResult {
  status: 'success' | 'failed' | 'timeout'
  fileName: string
  message: string
}

/**
 * Upload a PDF into the shared base corpus. Blocks until the backend reports
 * a terminal ingest state, so the caller can refresh the corpus list right
 * away. Platform-owner authorization happens in the route.
 */
export async function uploadKnowledgeBaseDocument(file: File): Promise<KnowledgeUploadResult> {
  const name = requirePdfBasename(file.name)
  const form = new FormData()
  form.append('file', file, name)

  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/admin/oib/documents`, {
      method: 'POST',
      headers: adminHeaders(),
      body: form,
      // Ingestion is blocking on the backend (polls up to 10 minutes).
      signal: AbortSignal.timeout(660_000),
    })
  } catch (error) {
    throw new UpstreamError('Knowledge backend unreachable', error instanceof Error ? error.message : undefined)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new UpstreamError(`Knowledge backend returned ${res.status}`, detail.slice(0, 500))
  }
  const body = await res.json().catch(() => ({}))
  const status = body?.status === 'success' || body?.status === 'failed' || body?.status === 'timeout'
    ? body.status
    : 'failed'
  return { status, fileName: asString(body?.file_name) ?? name, message: asString(body?.message) ?? '' }
}

/** Delete an admin-uploaded corpus document (repo-shipped files are immutable). */
export async function deleteKnowledgeBaseDocument(fileName: string): Promise<void> {
  const name = requirePdfBasename(fileName)
  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/admin/oib/documents/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: adminHeaders(),
      signal: AbortSignal.timeout(KNOWLEDGE_STATUS_TIMEOUT_MS),
    })
  } catch (error) {
    throw new UpstreamError('Knowledge backend unreachable', error instanceof Error ? error.message : undefined)
  }
  if (res.status === 404) {
    throw new NotFoundError('No uploaded document with that name')
  }
  if (!res.ok) {
    throw new UpstreamError(`Knowledge backend returned ${res.status}`)
  }
}

export interface KnowledgeSyncResult {
  filesAdded: number
  filesTotal: number
  message: string
}

/** Trigger an incremental corpus re-sync (new/changed PDFs are re-ingested). */
export async function syncKnowledgeBase(): Promise<KnowledgeSyncResult> {
  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/admin/oib/sync`, {
      method: 'POST',
      headers: adminHeaders(),
      // A full first-time sync embeds the whole corpus; give it 10 minutes.
      signal: AbortSignal.timeout(660_000),
    })
  } catch (error) {
    throw new UpstreamError('Knowledge backend unreachable', error instanceof Error ? error.message : undefined)
  }
  if (!res.ok) {
    throw new UpstreamError(`Knowledge backend returned ${res.status}`)
  }
  const body = await res.json().catch(() => ({}))
  return {
    filesAdded: asCount(body?.files_added),
    filesTotal: asCount(body?.files_total),
    message: asString(body?.message) ?? '',
  }
}

/**
 * Stream a corpus source PDF from the backend (for the citation/source
 * viewer). Returns a Response suitable to hand straight back to the browser.
 */
export async function streamKnowledgeBaseDocument(fileName: string): Promise<Response> {
  const name = requirePdfBasename(fileName)
  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/oib/documents/${encodeURIComponent(name)}`)
  } catch (error) {
    throw new UpstreamError('Knowledge backend unreachable', error instanceof Error ? error.message : undefined)
  }
  if (res.status === 404) {
    throw new NotFoundError('Source PDF not available on this deployment')
  }
  if (!res.ok || !res.body) {
    throw new UpstreamError(`Knowledge backend returned ${res.status}`)
  }
  // ASCII-safe filename for the header; the viewer only needs inline display.
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_')
  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${asciiName}"`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}
