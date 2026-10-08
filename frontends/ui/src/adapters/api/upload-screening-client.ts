/**
 * Upload screening client (ADR-0083): the organization's policy and the
 * quarantine queue, through their first-party BFF routes.
 *
 *   - policy  → `GET|PUT /api/organization/upload-screening`
 *   - queue   → `GET     /api/quarantine`
 *   - release → `POST    /api/documents/[id]/quarantine/release`
 *   - delete  → each shelf's own delete route (project, Archiv, chat)
 *
 * The queue's server type lives in `lib/upload-screening/review.ts`, which is
 * server-only, so its wire shape is declared here. The verdict is NOT
 * re-declared: it is read back through `parseQuarantine`, the one schema the
 * server used to build it, so the two cannot drift.
 */

import { z } from 'zod'
import { uploadScreeningPolicySchema, type UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import { parseQuarantine, QUARANTINED_PREFIX, type QuarantineVerdict } from '@/lib/upload-screening/quarantine'
import { ApiRequestError } from './api-error'

const UploadScreeningResponseSchema = z.object({
  policy: uploadScreeningPolicySchema,
  suggested: z.boolean(),
  suggestion: uploadScreeningPolicySchema,
})

const SavedUploadScreeningSchema = z.object({
  policy: uploadScreeningPolicySchema,
  suggested: z.boolean(),
})

/** A verdict the server could not explain, or one this client cannot read, is `null`, never a guess. */
const verdictSchema = z
  .unknown()
  .transform((value): QuarantineVerdict | null =>
    value === null || value === undefined ? null : parseQuarantine(`${QUARANTINED_PREFIX}${JSON.stringify(value)}`)
  )

const QuarantineQueueItemSchema = z.object({
  id: z.string(),
  filename: z.string(),
  scope: z.enum(['project', 'archiv', 'session']),
  projectId: z.string().nullable(),
  conversationId: z.string().nullable(),
  uploadedBy: z.string(),
  quarantinedAt: z.string(),
  verdict: verdictSchema,
})

const QuarantineQueueSchema = z.object({ items: z.array(QuarantineQueueItemSchema) })

export type UploadScreeningState = z.infer<typeof UploadScreeningResponseSchema>
export type QuarantineQueueItem = z.infer<typeof QuarantineQueueItemSchema>
export type QuarantineScope = QuarantineQueueItem['scope']

async function requestError(response: Response, fallback: string): Promise<ApiRequestError> {
  const body: unknown = await response.json().catch(() => null)
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  return new ApiRequestError(
    typeof message === 'string' && message ? message : `${fallback}: ${response.status}`,
    response.status
  )
}

/** The policy in force, whether it is still Piloti's suggestion, and that suggestion. */
export async function getUploadScreening(signal?: AbortSignal): Promise<UploadScreeningState> {
  const response = await fetch('/api/organization/upload-screening', { signal })
  if (!response.ok) throw await requestError(response, 'Failed to load the screening policy')
  return UploadScreeningResponseSchema.parse(await response.json())
}

/** Save the office's own policy. A 403 arrives as `ApiRequestError` with that status. */
export async function saveUploadScreening(
  policy: UploadScreeningPolicy
): Promise<z.infer<typeof SavedUploadScreeningSchema>> {
  const response = await fetch('/api/organization/upload-screening', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(policy),
  })
  if (!response.ok) throw await requestError(response, 'Failed to save the screening policy')
  return SavedUploadScreeningSchema.parse(await response.json())
}

/** The quarantined documents this session may review, newest first. */
export async function listQuarantineQueue(signal?: AbortSignal): Promise<QuarantineQueueItem[]> {
  const response = await fetch('/api/quarantine', { signal })
  if (!response.ok) throw await requestError(response, 'Failed to load the quarantine queue')
  return QuarantineQueueSchema.parse(await response.json()).items
}

/** Release one document: it is read again, unscreened, like any other upload. */
export async function releaseQuarantinedDocument(documentId: string): Promise<void> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/quarantine/release`, {
    method: 'POST',
  })
  if (!response.ok) throw await requestError(response, 'Failed to release the document')
}

/** Where each shelf deletes one of its documents. */
const DELETE_ROUTE: Record<QuarantineScope, (id: string) => string> = {
  project: (id) => `/api/documents/${encodeURIComponent(id)}`,
  archiv: (id) => `/api/archiv/documents/${encodeURIComponent(id)}`,
  session: (id) => `/api/session/documents/${encodeURIComponent(id)}`,
}

/**
 * Delete one quarantined document through its shelf's delete route.
 *
 * Unlike the shelves' own helpers, a 404 is a failure here. The row was just
 * listed as reviewable, so "not found" means this session may not delete it
 * (a chat attachment answers 404 to anyone who is not in that chat), and
 * dropping the row would claim a delete that did not happen.
 */
export async function deleteQuarantinedDocument(item: Pick<QuarantineQueueItem, 'id' | 'scope'>): Promise<void> {
  const response = await fetch(DELETE_ROUTE[item.scope](item.id), { method: 'DELETE' })
  if (!response.ok) throw await requestError(response, 'Failed to delete the document')
}
