/**
 * The sweep that finishes what no reader is left to finish (ADR-0086).
 *
 * Reconciliation settles a batch whenever somebody reads its documents, and the
 * browser that uploaded them polls while its tab is open. Close the tab and
 * nothing reads them: the upload is done, and its uploader is never told. The
 * scheduler therefore calls this every tick (`scheduler/index.js`), as it does
 * the run reconciler.
 *
 *  - A batch nobody sealed (the tab closed mid-upload) is sealed on its behalf
 *    once no file has come into it for {@link ABANDONED_AFTER_MS}: whatever
 *    reached the server is the upload. Idle, not old: a folder of thousands
 *    of files, or a mail import filing for hours (ADR-0085), is still being
 *    uploaded long after half an hour, and sealing it then would stamp the
 *    rest of its files with no batch at all.
 *  - Its documents still in flight are reconciled, which persists their status
 *    and settles the batch through the same hook a reader's read uses.
 *  - A quarantine whose audit event did not go out when its row moved is sent
 *    (`upload-screening/quarantine-audit.ts`, `sweepOwedQuarantines`): the
 *    content gate's decisions reach the trail at least once. Then the spent
 *    decisions are deleted (`pruneSpentQuarantines`): the ones the trail has,
 *    and any older than the week in which they are sent.
 *
 * Replica-safe: completion is a guarded UPDATE, so two sweeps that settle the
 * same batch emit one inbox item.
 */

import 'server-only'
import { withTenant } from '@/lib/db/tenant-context'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { pruneSpentQuarantines, sweepOwedQuarantines } from '@/lib/upload-screening/quarantine-audit'
import type { UploadBatch } from '@/lib/db/schema'
import {
  latestBatchDocumentAt,
  listInFlightBatchDocuments,
  listOpenBatchesBetween,
  sealAbandonedBatch,
} from './repository'
import { settleUploadBatches } from './settle'

/** A batch younger than this is still being uploaded; its browser settles it. */
const SETTLE_GRACE_MS = 60_000
/** A batch unsealed and without a new file for this long was abandoned by its uploader. */
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
  /** Owed quarantine decisions sent to the audit trail. */
  audited: number
  /** Spent quarantine decisions deleted (retention). */
  pruned: number
}

export async function sweepUploadBatches(now: Date = new Date()): Promise<UploadSweepResult> {
  const open = await listOpenBatchesBetween(
    new Date(now.getTime() - SWEEP_WINDOW_MS),
    new Date(now.getTime() - SETTLE_GRACE_MS),
    SWEEP_BATCH
  )
  const result: UploadSweepResult = {
    checked: open.length,
    sealed: 0,
    completed: 0,
    failed: 0,
    audited: 0,
    pruned: 0,
  }
  for (const batch of open) {
    try {
      await withTenant({ organizationId: batch.organizationId }, async () => {
        if (!batch.sealedAt && (await isAbandoned(batch, now))) {
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
  // After the batches: a quarantine their reconciliation just moved was sent
  // by that read, and is not the sweep's for another minute.
  try {
    result.audited = await sweepOwedQuarantines(now)
  } catch (error) {
    console.warn('[upload-batches] sweep could not list the owed quarantine decisions:', error)
  }
  // After the send, so a decision is deleted only once it was sent or stopped
  // being sent; whether or not the trail is on.
  try {
    result.pruned = await pruneSpentQuarantines(now)
  } catch (error) {
    console.warn('[upload-batches] sweep could not delete the spent quarantine decisions:', error)
  }
  return result
}

/** Unsealed, and nothing has come into it for {@link ABANDONED_AFTER_MS}, counted from its opening when nothing has. */
async function isAbandoned(batch: UploadBatch, now: Date): Promise<boolean> {
  const idleSince = (at: Date) => now.getTime() - at.getTime() > ABANDONED_AFTER_MS
  if (!idleSince(new Date(batch.createdAt))) return false
  const latest = await latestBatchDocumentAt(batch.organizationId, batch.id)
  return latest === null || idleSince(latest)
}
