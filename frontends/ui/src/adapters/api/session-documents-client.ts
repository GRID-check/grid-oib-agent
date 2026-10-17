/**
 * Session documents client: the files attached privately to one chat
 * (ADR-0047 Phase 2, `scope = 'session'`).
 *
 * Every call goes to a first-party BFF route, never to the ingestor through
 * the `/api/v1` proxy. The upload itself, `POST /api/session/documents/upload`
 * (file-type gate, storage quota, document row, SeaweedFS, dispatch), is sent
 * by `useFileUpload` through the same per-file XHR as the other shelves, so it
 * reports byte progress:
 *
 *   - list    → `GET    /api/session/documents?conversationId=` (reconciles
 *     in-flight statuses, so re-listing is also how an upload is polled);
 *   - delete  → `DELETE /api/session/documents/[id]` (chunks, objects, row).
 *
 * The rows are handed to the documents store in the collection-file shape it
 * already reads (`FileInfo`), with the DOCUMENT id as `file_id`, so a delete
 * names the row it removes.
 */

import { z } from 'zod'
import { surfaceStateOf, type SurfaceState } from '@/lib/documents/surface-state'
import { verdictSchema } from '@/lib/upload-screening/quarantine'
import type { FileInfo, ListedFileStatus } from './documents-schemas'

const SessionDocumentRowSchema = z.object({
  id: z.string(),
  filename: z.string(),
  fileSize: z.number().nullable().optional(),
  status: z.string(),
  collectionName: z.string(),
  createdAt: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  /** Why a held attachment is held (ADR-0113). A verdict that does not parse reads as none, never as a failed list. */
  quarantine: verdictSchema.nullable().catch(null).optional(),
  chunkCount: z.number().nullable().optional(),
})

const SessionDocumentListSchema = z.object({
  documents: z.array(SessionDocumentRowSchema),
  collectionName: z.string(),
})

export type SessionDocumentRow = z.infer<typeof SessionDocumentRowSchema>

/**
 * Each state's word in the listed-file vocabulary. Only `citable` is
 * `success`, the status every chat surface counts as an available source.
 *
 * - In flight (`uploading`, `reading`) is `ingesting`, which the chat polls.
 * - `stored`: an attachment stored and never read (`uploaded`) has nothing in
 *   the index and no passing verdict, so the chat cannot answer from it
 *   (ADR-0086). It used to come back `success` and read as available.
 * - `held`: the content check stopped it; never offered a retry.
 * - An undeclared status is at rest, or the poll would never end, and not
 *   `success` either: nothing is known about it, so it is not a source.
 */
const LISTED_STATUS_BY_STATE: Record<SurfaceState, ListedFileStatus> = {
  citable: 'success',
  uploading: 'ingesting',
  reading: 'ingesting',
  held: 'held',
  unreadable: 'failed',
  stored: 'stored',
  unknown: 'stored',
}

/**
 * A document row's status in the listed-file vocabulary, from the one status
 * table (`surfaceStateOf`), by the status alone as every other surface reads it.
 */
export function sessionDocumentFileStatus(status: string): ListedFileStatus {
  return LISTED_STATUS_BY_STATE[surfaceStateOf(status)]
}

/** A session document row in the shape the documents store reads. */
export function sessionDocumentToFileInfo(row: SessionDocumentRow): FileInfo {
  return {
    file_id: row.id,
    file_name: row.filename,
    collection_name: row.collectionName,
    status: sessionDocumentFileStatus(row.status),
    file_size: row.fileSize ?? null,
    chunk_count: row.chunkCount ?? 0,
    uploaded_at: row.createdAt ?? null,
    error_message: row.errorMessage ?? null,
    quarantine: row.quarantine ?? null,
    metadata: {},
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null)
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  return typeof message === 'string' && message ? message : `${fallback}: ${response.status}`
}

/** One chat's attachments, statuses reconciled. `null` when the conversation is not (yet) on the server. */
export async function listSessionDocuments(
  conversationId: string,
  signal?: AbortSignal
): Promise<FileInfo[] | null> {
  const response = await fetch(
    `/api/session/documents?conversationId=${encodeURIComponent(conversationId)}`,
    { signal }
  )
  if (response.status === 404) return null
  if (!response.ok) throw new Error(await errorMessage(response, 'Failed to list attachments'))
  const { documents } = SessionDocumentListSchema.parse(await response.json())
  return documents.map(sessionDocumentToFileInfo)
}

/** Delete one attachment. A document that is already gone is success. */
export async function deleteSessionDocument(documentId: string): Promise<void> {
  const response = await fetch(`/api/session/documents/${encodeURIComponent(documentId)}`, {
    method: 'DELETE',
  })
  if (response.ok || response.status === 404) return
  throw new Error(await errorMessage(response, 'Failed to delete attachment'))
}
