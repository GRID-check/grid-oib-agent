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
import { documentStatusFacts } from '@/lib/documents/document-status'
import type { DocumentFileStatus, FileInfo } from './documents-schemas'

const SessionDocumentRowSchema = z.object({
  id: z.string(),
  filename: z.string(),
  fileSize: z.number().nullable().optional(),
  status: z.string(),
  collectionName: z.string(),
  createdAt: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  chunkCount: z.number().nullable().optional(),
})

const SessionDocumentListSchema = z.object({
  documents: z.array(SessionDocumentRowSchema),
  collectionName: z.string(),
})

export type SessionDocumentRow = z.infer<typeof SessionDocumentRowSchema>

/**
 * A document row's status in the tracked-file vocabulary. Derived from the one
 * status table (`lib/documents/document-status`): in flight is `ingesting`,
 * a failure or a quarantine is `failed`, anything else at rest is `success`. An undeclared
 * status is at rest: reading it as in flight would poll it forever.
 */
export function sessionDocumentFileStatus(status: string): DocumentFileStatus {
  const facts = documentStatusFacts(status)
  if (facts?.phase === 'in-flight') return 'ingesting'
  // A quarantined attachment (ADR-0085) is not readable either, and saying
  // „success" would tell the chat it can be asked about.
  return facts?.variant === 'destructive' || facts?.variant === 'warning' ? 'failed' : 'success'
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
