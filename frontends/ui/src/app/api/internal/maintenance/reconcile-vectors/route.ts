/**
 * Internal orphaned-vector sweep — the seam a clock drives.
 *
 * The same reconciliation a platform owner starts from Platform → Vector
 * maintenance (`/api/platform/maintenance/reconcile-vectors`), minus the
 * person: chunks whose document row is gone are deleted, and summary rows
 * whose chunks are gone are forgotten. A cleanup that needs somebody to click
 * is not a ratchet — the orphans it recovers are invisible in the product, so
 * nobody knows to click. The caller is the `vector-reconcile` CronJob in
 * `deploy/pulumi/src/app/workers.ts`, same shape as `storage-alerts`.
 *
 * Token-guarded (`internalApiRoute`), not session-authenticated; there is no
 * general-purpose cron inside the BFF, so the work is exposed as a call any
 * scheduler can make (`/api/internal/storage/alerts` is the precedent).
 *
 * Idempotent: a clean store finds nothing and deletes nothing, which is what
 * makes at-least-once delivery from a CronJob safe. Each half is by construction
 * a no-op the second time: a chunk's row is gone or it is not, a summary's
 * chunks are there or they are not.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { reconcileOrphanedVectors } from '@/lib/platform/vector-reconcile'

export const POST = internalApiRoute(
  'VectorReconcile',
  // The counts come back in the response body, as the storage-alert sweep does
  // it: the CronJob's pod log captures the response, and that log is the run's
  // record. Per-collection failures are named in the body for the same reason.
  () => reconcileOrphanedVectors(),
  {
    tenancy: {
      crossTenant:
        'every collection in the deployment is compared against the document catalog across ' +
        'organizations; the reconciler steps up itself (withPlatformAccess) for that one read, and ' +
        'the vector-store calls carry no tenant',
    },
  },
)
