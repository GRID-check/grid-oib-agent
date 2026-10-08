/**
 * INTERNAL sweep — recover the background work a restart or a dead job left
 * half-done (ADR-0079):
 *
 *   - documents stranded at `processing`, whose IFC extraction or office
 *     conversion job is gone or dead (`lib/documents/stuck-processing.ts`);
 *   - research reports still `queued` for filing whose job is gone or dead
 *     (`lib/tasks/filing-sweep.ts`);
 *   - Outlook archive imports left open: an upload nobody finished, an import
 *     whose job is gone, a staged archive an ended import did not delete
 *     (`lib/mail-import/job.ts`, ADR-0085).
 *
 * Token-guarded housekeeping, not a person's request. The caller is the job
 * scheduler (`scheduler/index.js`), which already ticks every 30 s and already
 * posts the run reconciler beside this: there is no general-purpose cron inside
 * the BFF, so the work is a call a timer makes.
 *
 * Safe to call from several scheduler replicas at once and more often than
 * needed: a recovered row is no longer stranded, and a second dispatch for the
 * same object returns the job the first one queued. The parts are
 * independent, so one failing does not cost the others their turn; the counts
 * of each come back in the body for the caller's log.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { recoverStuckProcessing } from '@/lib/documents/stuck-processing'
import { sweepStaleMailImports } from '@/lib/mail-import/job'
import { recoverStuckFilings } from '@/lib/tasks/filing-sweep'

export const POST = internalApiRoute(
  'Background Work Reconcile',
  async () => {
    const [documents, filings, mailImports] = await Promise.allSettled([
      recoverStuckProcessing(),
      recoverStuckFilings(),
      sweepStaleMailImports(),
    ])
    // All ran, so a part that threw is rethrown only now: the others' work is
    // done and recorded either way, and the scheduler logs the failure.
    if (documents.status === 'rejected') throw documents.reason
    if (filings.status === 'rejected') throw filings.reason
    if (mailImports.status === 'rejected') throw mailImports.reason
    return { documents: documents.value, filings: filings.value, mailImports: mailImports.value }
  },
  {
    tenancy: {
      crossTenant:
        'discovery only: lists the documents, report filings and mail imports of every organization that have been left ' +
        'without a live job. Each is then recovered inside withTenant for its own organization, so the ' +
        'reads, the writes and the jobs it enqueues are subject to row-level security',
    },
  }
)
