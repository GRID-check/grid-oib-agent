/**
 * Per-document status reads: `GET /api/documents/{id}/status`, a bounded batch
 * at a time.
 *
 * The document lists used to follow an in-flight row by re-reading the WHOLE
 * listing (every page, up to 20 × 500 rows) every few seconds. What can change
 * while a row settles is that row, so the quiet settling tick asks about the
 * settling rows by id and merges the answers in; the full drain stays for the
 * loads that need the corpus. Per id rather than "the newest page": a
 * re-ingested OLD document is settling too, and it sits wherever its
 * `createdAt` put it, not on the first page.
 *
 * The same read settles the upload tray's rows that no ingest job follows, and
 * the orchestrator's handed-over rows, so all three agree on what an answer
 * looks like. The route is scope-aware (project, Archiv, chat), so one URL
 * serves every shelf.
 */

import { documentStatusFacts } from '@/lib/documents/document-status'
import { isFailedStatus } from '../components/document-status'
import type { FileItem } from '../components/project-file-workspace'
import type { TrackedFile } from '../types'
import { refreshedFileFields } from './file-item'

/** Most documents one tick asks about. A tick's cost stays flat however big the batch. */
export const STATUS_READ_BATCH = 24

/** Requests in flight at once within a tick. */
export const STATUS_READ_CONCURRENCY = 6

/** The fields of a status body a listing row takes over. */
export const STATUS_FIELDS: readonly (keyof FileItem)[] = [
  'status',
  'errorMessage',
  'summary',
  'pageCount',
  'chunkCount',
  'contentTypes',
  'tags',
  'versionCount',
  'queueAhead',
]

/** What a status read answered: the row's fresh fields, or that the row is gone. */
export type DocumentStatusRead = { kind: 'row'; fields: Partial<FileItem> } | { kind: 'gone' }

/** Keep only what the body carried of {@link STATUS_FIELDS}: absent is silence, not a reset. */
function statusFields(body: Record<string, unknown>): Partial<FileItem> {
  const fields: Record<string, unknown> = {}
  for (const field of STATUS_FIELDS) {
    if (field in body) fields[field] = body[field]
  }
  return fields as Partial<FileItem>
}

async function readOne(id: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<DocumentStatusRead | null> {
  try {
    const response = await fetcher(`/api/documents/${encodeURIComponent(id)}/status`, { signal })
    if (response.status === 404) return { kind: 'gone' }
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object') return null
    const record = body as Record<string, unknown>
    if (typeof record.status !== 'string') return null
    return { kind: 'row', fields: statusFields(record) }
  } catch {
    // Offline, aborted, a hiccup: no answer, and the next tick asks again.
    return null
  }
}

/**
 * Read the status of each id, {@link STATUS_READ_CONCURRENCY} at a time.
 *
 * Only ids that answered are in the result; a failed read is absent rather
 * than an error, because the caller's next tick is the retry.
 */
export async function readDocumentStatuses(
  ids: readonly string[],
  { fetcher = fetch, signal, concurrency = STATUS_READ_CONCURRENCY }: {
    fetcher?: typeof fetch
    signal?: AbortSignal
    concurrency?: number
  } = {}
): Promise<Map<string, DocumentStatusRead>> {
  const reads = new Map<string, DocumentStatusRead>()
  const queue = [...new Set(ids)]
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (signal?.aborted) return
      const read = await readOne(id, fetcher, signal)
      if (read) reads.set(id, read)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker))
  return reads
}

/**
 * Take the next batch of ids out of a longer list, round-robin.
 *
 * A folder upload of two hundred files settles over many ticks; asking about
 * the same first {@link STATUS_READ_BATCH} every time would starve the rest.
 *
 * @returns The batch and the offset the next call starts from.
 */
export function nextStatusBatch(
  ids: readonly string[],
  offset: number,
  size: number = STATUS_READ_BATCH
): { batch: string[]; next: number } {
  if (ids.length <= size) return { batch: [...ids], next: 0 }
  const start = offset % ids.length
  const batch = Array.from({ length: size }, (_, i) => ids[(start + i) % ids.length])
  return { batch, next: (start + size) % ids.length }
}

/**
 * Merge status reads into a listing by id.
 *
 * Each row goes through {@link refreshedFileFields}, so trailing metadata is
 * never erased and a terminal row is never moved back to settling by a stale
 * read. A row the server no longer has is dropped. Returns the SAME array when
 * nothing changed, so a quiet tick that learned nothing re-renders nothing.
 */
export function mergeStatusReads<T extends FileItem>(
  rows: readonly T[],
  reads: ReadonlyMap<string, DocumentStatusRead>
): T[] {
  if (reads.size === 0) return rows as T[]
  let changed = false
  const merged: T[] = []
  for (const row of rows) {
    const read = reads.get(row.id)
    if (!read) {
      merged.push(row)
      continue
    }
    if (read.kind === 'gone') {
      changed = true
      continue
    }
    const patch = refreshedFileFields(row, read.fields)
    if (!patch) {
      merged.push(row)
      continue
    }
    changed = true
    merged.push({ ...row, ...patch })
  }
  return changed ? merged : (rows as T[])
}

/** An upload tray row that only a status read will finish: accepted, jobless, still being read. */
export function isJoblessIngesting(upload: TrackedFile): boolean {
  return upload.status === 'ingesting' && !upload.jobId && !!upload.serverFileId
}

/**
 * The tray patch a terminal status settles an upload row with, or `null` while
 * the document is still being read — or reports a status this build does not
 * know, which is not an answer either way.
 */
export function trackedPatchFromStatus(
  status: string | null | undefined,
  errorMessage?: string | null
): Partial<TrackedFile> | null {
  if (documentStatusFacts(status)?.phase !== 'terminal') return null
  return isFailedStatus(status)
    ? { status: 'failed', errorMessage: errorMessage ?? undefined }
    : { status: 'success', progress: 100 }
}
