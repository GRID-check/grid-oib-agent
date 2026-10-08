/**
 * Download log client (ADR-0085): the admin read and the retention write,
 * through their first-party BFF routes.
 *
 *   - read      → `GET /api/organization/download-log`
 *   - retention → `PUT /api/organization/download-log/retention`
 *
 * The server types live in `lib/download-log/service.ts`, which is server-only,
 * so the wire shape is declared here and parsed, not trusted.
 */

import { z } from 'zod'
import { DOWNLOAD_LOG_KINDS, DOWNLOAD_LOG_SCOPES } from '@/lib/download-log/kinds'
import { ApiRequestError } from './api-error'

const EntrySchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  userId: z.string(),
  person: z.object({ name: z.string(), email: z.string().nullable() }).nullable(),
  kind: z.enum(DOWNLOAD_LOG_KINDS),
  access: z.enum(['download', 'open']),
  scope: z.enum(DOWNLOAD_LOG_SCOPES),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  documentId: z.string(),
  documentName: z.string(),
  versionId: z.string().nullable(),
  folderId: z.string().nullable(),
  folderPath: z.string().nullable(),
  ownList: z.boolean(),
})

const PageSchema = z.object({
  entries: z.array(EntrySchema),
  nextCursor: z.string().nullable(),
  retentionDays: z.number().int(),
})

export type DownloadLogEntry = z.infer<typeof EntrySchema>
export type DownloadLogPage = z.infer<typeof PageSchema>

/** What the admin typed. Empty strings mean "no filter". */
export interface DownloadLogFilters {
  userId: string
  document: string
  /** `YYYY-MM-DD`, inclusive. */
  from: string
  /** `YYYY-MM-DD`, inclusive. */
  to: string
  kind: string
}

export const NO_FILTERS: DownloadLogFilters = { userId: '', document: '', from: '', to: '', kind: '' }

async function requestError(response: Response, fallback: string): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null)
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  return new ApiRequestError(
    typeof message === 'string' && message ? message : `${fallback}: ${response.status}`,
    response.status
  )
}

/** One page of the log. A refused read (403, or an audit event that could not be written) throws `ApiRequestError`. */
export async function fetchDownloadLog(
  filters: DownloadLogFilters,
  cursor: string | null,
  signal?: AbortSignal
): Promise<DownloadLogPage> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value.trim()) query.set(key, value.trim())
  }
  if (cursor) query.set('cursor', cursor)
  const response = await fetch(`/api/organization/download-log?${query.toString()}`, { signal })
  if (!response.ok) throw await requestError(response, 'Failed to load the download log')
  return PageSchema.parse(await response.json())
}

/** Save how many days the log is kept. The server refuses anything outside 30 to 365. */
export async function saveDownloadLogRetention(days: number): Promise<{ days: number; previous: number }> {
  const response = await fetch('/api/organization/download-log/retention', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days }),
  })
  if (!response.ok) throw await requestError(response, 'Failed to save the retention')
  return z.object({ days: z.number(), previous: z.number() }).parse(await response.json())
}
