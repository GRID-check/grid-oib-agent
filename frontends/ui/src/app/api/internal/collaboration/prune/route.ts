/**
 * Internal retention endpoint for collaboration data (spec IB-15).
 *
 * Token-guarded (`internalApiRoute`), not session-authenticated: this is
 * housekeeping, invoked by a scheduler rather than by a person. There is no
 * general-purpose cron inside the BFF, so rather than invent one this exposes the
 * prune as a call any scheduler can make — the compose/Kubernetes deployment
 * already runs a `workflow-scheduler` that ticks on a timer, and this fits the
 * same shape as its retention prune.
 *
 * Idempotent and bounded: each call deletes at most one batch, so a large backlog
 * is worked off over several ticks instead of taking a long lock on a table that
 * serves every page render. Calling it more often than needed is harmless.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { sweepOrphanedCollaborationRows } from '@/lib/collaboration/cleanup'
import { pruneExpiredInboxItems } from '@/lib/collaboration/retention'

export const POST = internalApiRoute('CollaborationPrune', async () => {
  const [retention, orphans] = await Promise.all([
    pruneExpiredInboxItems(),
    // Grants, requests and inbox items address their target as a polymorphic
    // (resource_type, resource_id) pair, so no foreign key can cascade into them.
    // A conversation hard-deleted outside this tier — notably the cascade when a
    // project is purged — therefore leaves them behind. Reconciling here is
    // cheaper and more robust than hooking every purge path, some of which do not
    // live in the BFF at all.
    sweepOrphanedCollaborationRows(),
  ])
  return {
    pruned: retention.deleted,
    cutoff: retention.cutoff,
    orphansRemoved: orphans,
  }
}, {
  tenancy: {
    crossTenant:
      'retention housekeeping sweeps expired and orphaned rows across every organization at once',
  },
})
