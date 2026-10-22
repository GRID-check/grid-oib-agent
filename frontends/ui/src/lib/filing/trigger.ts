/**
 * When Piloti judges where an upload belongs (`./service`): twice per upload
 * batch, as its uploader, as a BFF job (`filing_review`) so it never blocks or
 * fails the upload.
 *
 * - **At the seal** (`sealOwnUploadBatch`): the bytes are in and the person is
 *   still looking at the tray. `basis: name`, queued `interactive`, so the
 *   suggestion arrives while they are there: the runner's poll (2 s by
 *   default, `GRID_BFF_JOBS_POLL_MS`) plus one model call.
 * - **At the settle** (`settleUploadBatches`): ingestion has read the batch.
 *   `basis: content`, queued `bulk`. It may sharpen or withdraw the first.
 *
 * `GRID_FILING_SUGGESTIONS=off` switches both off for a deployment, and a
 * batch opened with `reviewsFiling` off (migration 0185) for itself: a file a
 * person placed on purpose, such as a mail they filed, is not re-judged at a
 * model call per batch.
 *
 * Imports no service, so the seal and the settle do not pull the judgement
 * (and everything behind it) into the upload path.
 */

import 'server-only'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { UploadBatch } from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { BFF_JOB_PRIORITY, requesterOf, type FilingReviewPayload } from '@/lib/jobs-queue/types'
import type { FilingBasis } from './types'

/** Whether the deployment suggests filing at all. On unless switched off. */
export function filingSuggestionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.GRID_FILING_SUGGESTIONS ?? '').trim().toLowerCase() !== 'off'
}

type QueuedBatch = Pick<UploadBatch, 'id' | 'scope' | 'createdBy' | 'reviewsFiling'>

/** Queue one review of `batch` as its uploader. Whether one was queued. Never throws. */
export async function queueFilingReview(organizationId: string, batch: QueuedBatch, basis: FilingBasis): Promise<boolean> {
  // A chat's attachments have no folders to belong in, and a batch opened
  // without reviews was placed by a person who already decided where.
  if (!filingSuggestionsEnabled() || batch.scope === 'session' || !batch.reviewsFiling) return false
  try {
    const session = await resolvePinnedRequesterSession({ userId: batch.createdBy, email: null, organizationId })
    if (!session) return false
    const payload: FilingReviewPayload = { batchId: batch.id, basis, requester: requesterOf(session) }
    await withTenant({ organizationId }, () =>
      enqueueJob({
        kind: 'filing_review',
        organizationId,
        payload,
        priority: basis === 'name' ? BFF_JOB_PRIORITY.interactive : BFF_JOB_PRIORITY.bulk,
      })
    )
    return true
  } catch (error) {
    console.warn(`[filing] queueing the ${basis} review of batch ${batch.id} failed; the upload is unaffected:`, error)
    return false
  }
}

/** After these batches completed: one content review each. Never throws. */
export async function queueFilingReviewsAfterSettle(
  organizationId: string,
  completed: readonly QueuedBatch[]
): Promise<void> {
  await Promise.all(completed.map((batch) => queueFilingReview(organizationId, batch, 'content')))
}
