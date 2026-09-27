/**
 * INTERNAL sweep — close the runs whose ending never reached this tier
 * (`lib/runs/reconcile.ts`, backlog T3-11).
 *
 * Token-guarded housekeeping, not a person's request. The caller is the job
 * scheduler (`scheduler/index.js`), which already ticks every 30 s, already
 * posts to this tier's internal routes, and already owns the other `task_runs`
 * maintenance (the retention prune). There is no general-purpose cron inside the
 * BFF, so the work is a call a timer makes, the same shape as the storage-alert
 * sweep and the collaboration prune.
 *
 * Safe to call from several scheduler replicas at once and more often than
 * needed: the claim stamps each run it takes (`FOR UPDATE SKIP LOCKED`), so a
 * second concurrent sweep takes different runs and a repeated one takes none
 * until the stale window has passed. The counts come back in the body for the
 * caller's log.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { reconcileStaleRuns } from '@/lib/runs/reconcile'

export const POST = internalApiRoute('Run Reconcile', () => reconcileStaleRuns(), {
  tenancy: {
    crossTenant:
      'discovery only: claims the still-active task_runs of every organization that nothing has checked recently. ' +
      'Each claimed run is then reconciled inside withTenant for its own organization, so the message, ledger ' +
      'and row writes are subject to row-level security',
  },
})
