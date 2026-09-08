/**
 * Internal reconcile endpoint for the Projektregister (spec PR-7, MG-2).
 *
 * Token-guarded (`internalApiRoute`), not session-authenticated: this is
 * housekeeping, invoked by the scheduler rather than by a person — the same
 * shape as `POST /api/internal/collaboration/prune`, for the same reason
 * (there is no general-purpose cron inside the BFF, so the work is exposed as
 * a call any scheduler can make).
 *
 * Bounded and idempotent. One call rebuilds at most
 * {@link REGISTER_RECONCILE_BATCH} Steckbriefe, so a backlog — an organization
 * that existed before the register, which is every organization on the day
 * this ships — is worked off over several ticks instead of holding one long
 * transaction against a table the office reads on every turn. A rebuild clears
 * `stale_at`, so calling this more often than needed costs a query that claims
 * nothing.
 *
 * The MISSING and the STALE are one batch on purpose (MG-2): the backfill for
 * projects that predate the register and the repair of a missed write-through
 * are the same work, so they share one code path and one set of bugs.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { REGISTER_RECONCILE_BATCH, reconcileProjectRegister } from '@/lib/workspace/register-service'

export const POST = internalApiRoute(
  'WorkspaceRegisterReconcile',
  async () => {
    const result = await reconcileProjectRegister(REGISTER_RECONCILE_BATCH)
    return { ...result, batchSize: REGISTER_RECONCILE_BATCH }
  },
  {
    tenancy: {
      crossTenant:
        'the register reconcile finds stale and missing Steckbriefe across every organization, then rebuilds each inside its own tenant scope',
    },
  }
)
