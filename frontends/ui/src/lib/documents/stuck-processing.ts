/**
 * The sweep for documents stranded at `processing` (ADR-0078).
 *
 * `processing` is the status of work the BFF itself owns: an IFC model being
 * parsed, an office file being converted. Before those became `bff_job_queue`
 * jobs, a restart mid-way left the row at `processing` with nothing behind it,
 * and the only way out was a person pressing "Erneut lesen". Two cases are still
 * left, and this is the clock behind both:
 *
 *   - **No job.** Rows written before the jobs existed, and a job that could not
 *     be queued after the row was marked. They get a new job.
 *   - **A dead job.** The queue gave up after its last attempt. The row says so
 *     and waits for a person's retry; queueing a fifth attempt for work that
 *     failed four times would only spend the same minutes again.
 *
 * A row whose job is queued or running is left alone, however long it waits:
 * the listing joins on the job id the row remembers, so a backlog of thousands
 * of waiting rows never crowds the lost ones out of a batch.
 *
 * The caller is the job scheduler (`scheduler/index.js`), the same clock that
 * drives the run reconciler, through `POST /api/internal/
 * maintenance/reconcile-background-work`. Safe to run from several replicas at once and more
 * often than needed: a row it recovers is no longer stranded, and a second
 * dispatch for one object returns the job the first one queued.
 */

import 'server-only'
import { withTenant } from '@/lib/db/tenant-context'
import { INGEST_DISPATCH_FAILED_MESSAGE, redispatchStuckDocument } from './service'
import { listStuckProcessingDocuments, markDocumentIngestFailed, type StuckProcessingDocument } from './repository'

/** A row must have sat at `processing` this long before the sweep touches it. */
export const STUCK_AFTER_MINUTES = 15

/** Rows one sweep recovers. Bounded: it is housekeeping on a timer. */
export const STUCK_BATCH = 50

export interface StuckProcessingSweepResult {
  checked: number
  requeued: number
  /** Rows failed with a reason because they cannot be rebuilt or their job died. */
  failed: number
  /** Rows that were gone or had moved on by the time the sweep got to them. */
  gone: number
  /** Rows whose recovery threw; each is found again by the next sweep. */
  errors: number
}

async function recoverOne(row: StuckProcessingDocument): Promise<'requeued' | 'failed' | 'gone'> {
  if (row.jobStatus === 'dead') {
    await markDocumentIngestFailed(row.id, row.organizationId, INGEST_DISPATCH_FAILED_MESSAGE)
    console.warn(`[documents] ${row.id} failed every attempt of its background job: ${row.lastError ?? 'no reason kept'}`)
    return 'failed'
  }
  return redispatchStuckDocument(row.organizationId, row.id)
}

/**
 * One sweep: find the stranded rows across every organization, then recover
 * each inside its own. Never throws for one row's failure; the counts say what
 * happened.
 */
export async function recoverStuckProcessing(
  now: Date = new Date(),
  options: { staleMinutes?: number; batch?: number } = {}
): Promise<StuckProcessingSweepResult> {
  const before = new Date(now.getTime() - (options.staleMinutes ?? STUCK_AFTER_MINUTES) * 60_000)
  const rows = await listStuckProcessingDocuments(before, options.batch ?? STUCK_BATCH)

  const result: StuckProcessingSweepResult = { checked: rows.length, requeued: 0, failed: 0, gone: 0, errors: 0 }
  for (const row of rows) {
    try {
      const outcome = await withTenant({ organizationId: row.organizationId }, () => recoverOne(row))
      result[outcome] += 1
    } catch (error) {
      console.error('[documents] could not recover document', row.id, 'left at processing', error)
      result.errors += 1
    }
  }
  return result
}
