/**
 * Upload screening client (ADR-0086): the organization's policy and the
 * quarantine queue, through their first-party BFF routes.
 *
 *   - policy  → `GET|PUT /api/organization/upload-screening`
 *   - queue   → `GET     /api/quarantine`
 *   - access  → `GET     /api/documents/[id]/quarantine`
 *   - release → `POST    /api/documents/[id]/quarantine/release`
 *   - ask     → `POST    /api/documents/[id]/quarantine/request-release`
 *   - delete  → each shelf's own delete route (project, Archiv, chat)
 *
 * The queue's server type lives in `lib/upload-screening/review.ts`, which is
 * server-only, so its wire shape is declared here. The verdict is NOT
 * re-declared: it is read with `verdictSchema`, the one schema the server used
 * to build it, so the two cannot drift.
 */

import { z } from 'zod'
import { uploadScreeningPolicySchema, type UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import { verdictSchema } from '@/lib/upload-screening/quarantine'
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
const QuarantineFieldSchema = verdictSchema.nullable().catch(null)

const QuarantineQueueItemSchema = z.object({
  id: z.string(),
  // Absent from a BFF older than the field: every row it listed was a quarantine.
  held: z.enum(['quarantined', 'unscreened']).default('quarantined'),
  filename: z.string(),
  scope: z.enum(['project', 'archiv', 'session']),
  projectId: z.string().nullable(),
  conversationId: z.string().nullable(),
  uploadedBy: z.string(),
  quarantinedAt: z.string(),
  verdict: QuarantineFieldSchema,
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

const ReleaseSchema = z.object({ status: z.string() })

/**
 * Release one document: it is read again, unscreened, like any other upload.
 * Resolves to the status it was dispatched with (`uploaded`, `processing`, …),
 * so a surface showing the document can show it being read.
 */
export async function releaseQuarantinedDocument(documentId: string): Promise<{ status: string }> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/quarantine/release`, {
    method: 'POST',
  })
  if (!response.ok) throw await requestError(response, 'Failed to release the document')
  return ReleaseSchema.parse(await response.json())
}

const QuarantineReviewAccessSchema = z.object({ canReview: z.boolean(), canAskForReview: z.boolean() })
export type QuarantineReviewAccess = z.infer<typeof QuarantineReviewAccessSchema>

/** What this session may do about one held document: decide about it, or ask for a decision. */
export async function getQuarantineReviewAccess(
  documentId: string,
  signal?: AbortSignal
): Promise<QuarantineReviewAccess> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/quarantine`, { signal })
  if (!response.ok) throw await requestError(response, 'Failed to read what may be done about the document')
  return QuarantineReviewAccessSchema.parse(await response.json())
}

const ReleaseRequestSchema = z.object({ id: z.string(), notified: z.number().int().nonnegative() })

/**
 * Ask the people who may release one of your quarantined files to look at it.
 * Resolves to how many were told; zero means nobody but the uploader may.
 */
export async function requestQuarantineRelease(documentId: string): Promise<{ notified: number }> {
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/quarantine/request-release`, {
    method: 'POST',
  })
  if (!response.ok) throw await requestError(response, 'Failed to ask for the release')
  return ReleaseRequestSchema.parse(await response.json())
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
