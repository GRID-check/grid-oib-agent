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
  docClass: string | null
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
  doc_class?: unknown
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
    docClass: asString(entry.doc_class),
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

/** Basename-only, `.pdf`- OR `.zip`-only — the two shapes the upload accepts. */
function requireUploadBasename(fileName: string): string {
  const name = fileName.trim()
  const lower = name.toLowerCase()
  if (!name || name !== name.replace(/[/\\]/g, '') || !(lower.endsWith('.pdf') || lower.endsWith('.zip'))) {
    throw new BadRequestError('A .pdf or .zip file name without path segments is required')
  }
  return name
}

/** One PDF queued from a ZIP bulk upload (or rejected during extraction). */
export interface KnowledgeUploadMember {
  fileName: string
  status: 'pending' | 'rejected'
  docClass: string | null
  reason: string | null
}

export interface KnowledgeUploadResult {
  status: 'pending' | 'success' | 'failed' | 'timeout'
  kind: 'file' | 'zip'
  fileName: string | null
  docClass: string | null
  message: string
  accepted: number | null
  rejected: number | null
  members: KnowledgeUploadMember[] | null
}

/** Upload options: an optional explicit doc_class for a single-PDF upload. */
export interface KnowledgeUploadOptions {
  docClass?: string
}

/**
 * Upload a PDF — or a ZIP of PDFs — into the shared base corpus. Ingestion runs
 * in the background on the backend, so this returns promptly with status
 * `pending`; the caller polls the corpus status for the terminal lifecycle.
 * Platform-owner authorization happens in the route.
 */
export async function uploadKnowledgeBaseDocument(
  file: File,
  options: KnowledgeUploadOptions = {},
): Promise<KnowledgeUploadResult> {
  const name = requireUploadBasename(file.name)
  const form = new FormData()
  form.append('file', file, name)
  if (options.docClass) {
    form.append('doc_class', options.docClass)
  }

  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/admin/oib/documents`, {
      method: 'POST',
      headers: adminHeaders(),
      body: form,
      // The upload is non-blocking (ingestion is backgrounded), but a large ZIP
      // still travels + extracts; keep a generous ceiling.
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
  const rawStatus = body?.status
  const status =
    rawStatus === 'pending' || rawStatus === 'success' || rawStatus === 'failed' || rawStatus === 'timeout'
      ? rawStatus
      : 'failed'
  const members = Array.isArray(body?.members)
    ? body.members.map(
        (m: Record<string, unknown>): KnowledgeUploadMember => ({
          fileName: asString(m?.file_name) ?? 'unknown',
          status: m?.status === 'pending' ? 'pending' : 'rejected',
          docClass: asString(m?.doc_class),
          reason: asString(m?.reason),
        }),
      )
    : null
  return {
    status,
    kind: body?.kind === 'zip' ? 'zip' : 'file',
    fileName: asString(body?.file_name),
    docClass: asString(body?.doc_class),
    message: asString(body?.message) ?? '',
    accepted: typeof body?.accepted === 'number' ? body.accepted : null,
    rejected: typeof body?.rejected === 'number' ? body.rejected : null,
    members,
  }
}

/**
 * Reclassify a base-corpus document's Dokumentart (doc_class). Because retrieval
 * is store-authoritative, the change reflects immediately with no re-ingest.
 */
export async function updateKnowledgeBaseDocClass(fileName: string, docClass: string): Promise<void> {
  const name = requirePdfBasename(fileName)
  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/admin/oib/documents/${encodeURIComponent(name)}/doc-class`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_class: docClass }),
      signal: AbortSignal.timeout(KNOWLEDGE_STATUS_TIMEOUT_MS),
    })
  } catch (error) {
    throw new UpstreamError('Knowledge backend unreachable', error instanceof Error ? error.message : undefined)
  }
  if (res.status === 400) {
    const detail = await res.text().catch(() => '')
    throw new BadRequestError(detail.slice(0, 500) || 'Invalid doc_class')
  }
  if (res.status === 404) {
    throw new NotFoundError('No summary found for that document')
  }
  if (!res.ok) {
    throw new UpstreamError(`Knowledge backend returned ${res.status}`)
  }
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
    res = await fetch(`${getBackendUrl()}/v1/oib/documents/${encodeURIComponent(name)}`, {
      // Corpus source PDFs are small and cached (5 min); bound the call so an
      // unreachable backend rejects promptly instead of hanging the viewer.
      signal: AbortSignal.timeout(KNOWLEDGE_STATUS_TIMEOUT_MS),
    })
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
