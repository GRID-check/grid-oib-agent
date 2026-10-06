/**
 * INTERNAL sweep — recover the background work a restart or a dead job left
 * half-done (ADR-0078):
 *
 *   - documents stranded at `processing`, whose IFC extraction or office
 *     conversion job is gone or dead (`lib/documents/stuck-processing.ts`);
 *   - research reports still `queued` for filing whose job is gone or dead
 *     (`lib/tasks/filing-sweep.ts`).
 *
 * Token-guarded housekeeping, not a person's request. The caller is the job
 * scheduler (`scheduler/index.js`), which already ticks every 30 s and already
 * posts the run reconciler beside this: there is no general-purpose cron inside
 * the BFF, so the work is a call a timer makes.
 *
 * Safe to call from several scheduler replicas at once and more often than
 * needed: a recovered row is no longer stranded, and a second dispatch for the
 * same object returns the job the first one queued. The two halves are
 * independent, so one failing does not cost the other its turn; the counts of
 * both come back in the body for the caller's log.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { recoverStuckProcessing } from '@/lib/documents/stuck-processing'
import { recoverStuckFilings } from '@/lib/tasks/filing-sweep'

export const POST = internalApiRoute(
  'Background Work Reconcile',
  async () => {
    const [documents, filings] = await Promise.allSettled([recoverStuckProcessing(), recoverStuckFilings()])
    // Both ran, so a half that threw is rethrown only now: the other half's
    // work is done and recorded either way, and the scheduler logs the failure.
    if (documents.status === 'rejected') throw documents.reason
    if (filings.status === 'rejected') throw filings.reason
    return { documents: documents.value, filings: filings.value }
  },
  {
    tenancy: {
      crossTenant:
        'discovery only: lists the documents and report filings of every organization that have been left ' +
        'without a live job. Each is then recovered inside withTenant for its own organization, so the ' +
        'reads, the writes and the jobs it enqueues are subject to row-level security',
    },
  }
)
