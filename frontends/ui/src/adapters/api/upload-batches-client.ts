/**
 * Upload batches client (ADR-0086): what one upload brought in, and a
 * project's uploads over time.
 *
 *   - summary → `GET /api/upload-batches/[id]`       (the uploader's only; 404 for anyone else)
 *   - history → `GET /api/projects/[id]/uploads`      (project:view; keyset pages, `?cursor=`)
 *   - place   → `GET /api/projects/[id]`              (the project's name, for the summary's header)
 *
 * The server types (`UploadSummary`, `UploadHistoryEntry`) live in
 * `lib/upload-batches/service.ts`, which is server-only, so the wire shapes are
 * declared here. The quarantine verdict is NOT re-declared: it is read back
 * through `parseQuarantine`, the schema the server built it with, so the two
 * cannot drift.
 */

import { z } from 'zod'
import { parseQuarantine, QUARANTINED_PREFIX, type QuarantineVerdict } from '@/lib/upload-screening/quarantine'
import { ApiRequestError } from './api-error'

export const UPLOAD_OUTCOMES = ['ready', 'reading', 'quarantined', 'failed', 'stored'] as const
export type UploadOutcome = (typeof UPLOAD_OUTCOMES)[number]

/** A verdict this client cannot read is `null`, never a guess. */
const verdictSchema = z
  .unknown()
  .transform((value): QuarantineVerdict | null =>
    value === null || value === undefined ? null : parseQuarantine(`${QUARANTINED_PREFIX}${JSON.stringify(value)}`)
  )

const UploadSummaryDocumentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  displayName: z.string().nullable(),
  folderPath: z.string().nullable(),
  status: z.string(),
  outcome: z.enum(UPLOAD_OUTCOMES),
  screening: z.enum(['clean', 'partial', 'unchecked', 'quarantined', 'released']).nullable(),
  quarantine: verdictSchema,
  errorMessage: z.string().nullable(),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
  pageCount: z.number().nullable(),
  /** A new version of a document already there („geändert"). */
  replaced: z.boolean().default(false),
  /** Filed in a folder not every project member may read („geschützt"). */
  restricted: z.boolean().default(false),
})

const UploadSummarySchema = z.object({
  id: z.string(),
  scope: z.enum(['project', 'archiv', 'session']),
  projectId: z.string().nullable(),
  conversationId: z.string().nullable(),
  createdAt: z.string(),
  sealedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  expectedCount: z.number(),
  unchangedCount: z.number(),
  failedCount: z.number(),
  excluded: z.array(z.object({ term: z.string(), count: z.number() })),
  documents: z.array(UploadSummaryDocumentSchema),
})

const UploadHistoryEntrySchema = z.object({
  id: z.string(),
  createdBy: z.string(),
  createdByName: z.string().nullable().default(null),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  expectedCount: z.number(),
  unchangedCount: z.number(),
  failedCount: z.number(),
  excludedCount: z.number(),
  counts: z.object({
    ready: z.number(),
    reading: z.number(),
    quarantined: z.number(),
    failed: z.number(),
    stored: z.number(),
  }),
})

const UploadHistorySchema = z.object({
  uploads: z.array(UploadHistoryEntrySchema),
  nextCursor: z.string().nullable().default(null),
})

const ProjectNameSchema = z.object({ name: z.string() })

export type UploadSummary = z.infer<typeof UploadSummarySchema>
export type UploadSummaryDocument = z.infer<typeof UploadSummaryDocumentSchema>
export type UploadScope = UploadSummary['scope']
export type UploadHistoryEntry = z.infer<typeof UploadHistoryEntrySchema>
export type UploadHistoryPage = z.infer<typeof UploadHistorySchema>

async function requestError(response: Response, fallback: string): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null)
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  return new ApiRequestError(
    typeof message === 'string' && message ? message : `${fallback}: ${response.status}`,
    response.status
  )
}

/** One upload's summary. A 404 arrives as `ApiRequestError` with that status: gone, or someone else's. */
export async function getUploadSummary(batchId: string, signal?: AbortSignal): Promise<UploadSummary> {
  const response = await fetch(`/api/upload-batches/${encodeURIComponent(batchId)}`, { signal })
  if (!response.ok) throw await requestError(response, 'Failed to load the upload summary')
  return UploadSummarySchema.parse(await response.json())
}

/** One page of a project's uploads, newest first; `cursor` is the previous page's `nextCursor`. */
export async function listProjectUploads(
  projectId: string,
  { cursor, signal }: { cursor?: string; signal?: AbortSignal } = {}
): Promise<UploadHistoryPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/uploads${query}`, { signal })
  if (!response.ok) throw await requestError(response, 'Failed to load the upload history')
  return UploadHistorySchema.parse(await response.json())
}

/** The project's name, or `null` when it cannot be read (deleted, or no longer this reader's). */
export async function getProjectName(projectId: string, signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { signal })
  if (!response.ok) return null
  const parsed = ProjectNameSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data.name : null
}
