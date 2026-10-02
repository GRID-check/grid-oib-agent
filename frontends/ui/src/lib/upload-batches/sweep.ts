/**
 * The sweep that finishes what no reader is left to finish (ADR-0077).
 *
 * Reconciliation settles a batch whenever somebody reads its documents, and the
 * browser that uploaded them polls while its tab is open. Close the tab and
 * nothing reads them: the upload is done, and its uploader is never told. The
 * scheduler therefore calls this every tick (`scheduler/index.js`), as it does
 * the run reconciler.
 *
 *  - A batch the browser never sealed (the tab closed mid-upload) is sealed on
 *    its behalf after {@link ABANDONED_AFTER_MS}: whatever reached the server
 *    is the upload.
 *  - Its documents still in flight are reconciled, which persists their status
 *    and settles the batch through the same hook a reader's read uses.
 *
 * Replica-safe: completion is a guarded UPDATE, so two sweeps that settle the
 * same batch emit one inbox item.
 */

import 'server-only'
import { withTenant } from '@/lib/db/tenant-context'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { listInFlightBatchDocuments, listOpenBatchesBetween, sealAbandonedBatch } from './repository'
import { settleUploadBatches } from './settle'

/** A batch younger than this is still being uploaded; its browser settles it. */
const SETTLE_GRACE_MS = 60_000
/** A batch unsealed for this long was abandoned by its browser. */
export const ABANDONED_AFTER_MS = 30 * 60_000
/** Older than this, a batch is left alone: a document stuck in flight for a week is not news. */
const SWEEP_WINDOW_MS = 7 * 24 * 60 * 60_000
/** Batches one sweep looks at. */
export const SWEEP_BATCH = 25

export interface UploadSweepResult {
  checked: number
  sealed: number
  completed: number
  failed: number
}

export async function sweepUploadBatches(now: Date = new Date()): Promise<UploadSweepResult> {
  const open = await listOpenBatchesBetween(
    new Date(now.getTime() - SWEEP_WINDOW_MS),
    new Date(now.getTime() - SETTLE_GRACE_MS),
    SWEEP_BATCH
  )
  const result: UploadSweepResult = { checked: open.length, sealed: 0, completed: 0, failed: 0 }
  for (const batch of open) {
    try {
      await withTenant({ organizationId: batch.organizationId }, async () => {
        if (!batch.sealedAt && now.getTime() - new Date(batch.createdAt).getTime() > ABANDONED_AFTER_MS) {
          await sealAbandonedBatch(batch.organizationId, batch.id, now)
          result.sealed += 1
        }
        const inFlight = await listInFlightBatchDocuments(batch.organizationId, batch.id)
        if (inFlight.length > 0) await reconcileDocumentStatuses(inFlight, batch.organizationId)
        const completed = await settleUploadBatches(batch.organizationId, [batch.id])
        result.completed += completed.length
      })
    } catch (error) {
      result.failed += 1
      console.warn(`[upload-batches] sweep could not settle batch ${batch.id}:`, error)
    }
  }
  return result
}
