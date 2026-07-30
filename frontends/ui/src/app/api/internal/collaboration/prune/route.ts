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
import { pruneExpiredInboxItems } from '@/lib/collaboration/retention'

export const POST = internalApiRoute('CollaborationPrune', async () => {
  const result = await pruneExpiredInboxItems()
  return { pruned: result.deleted, cutoff: result.cutoff }
})
