/**
 * INTERNAL job fire endpoint - the scheduler POSTs `{ scheduleId }` here after
 * it has claimed a due row and advanced its next_run_at. Shared-token guarded
 * (GRID_INTERNAL_API_TOKEN via `internalApiRoute`, like
 * /api/internal/workflows/fire).
 *
 * The path and the `scheduleId` field keep their pre-jobs spelling on purpose:
 * the scheduler container and the BFF deploy separately, so renaming the wire
 * contract would fail every scheduled run in the window between the two
 * deploys — the same hazard the `execution` -> `output` shim exists for. It
 * names a `jobs.id`.
 *
 * Loads the job with NO session (the scheduler has none) and delegates to
 * `fireScheduledJob`, which re-checks `enabled` (the row may have been disabled
 * since the claim) and the org's feature gate before firing through the single
 * `fireJob` path.
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { NotFoundError } from '@/lib/api/errors'
import { fireScheduledJob, loadJobForFire } from '@/lib/jobs/service'
import { internalFireSchema } from '@/lib/jobs/types'

export const POST = internalApiRoute(
  'Job Fire',
  async ({ request }) => {
    const { scheduleId } = await parseJsonBody(request, internalFireSchema)

    // Narrow on purpose: the BYPASS covers only the lookup that genuinely has
    // no tenant yet. Everything the run then does - recording the run, reading
    // budgets, building the project scope - is one organization's work and is
    // done as that organization, so row-level security still applies to it.
    const job = await withPlatformAccess(
      'job fire: the scheduler identifies work by id, before any organization is known',
      () => loadJobForFire(scheduleId)
    )
    if (!job) throw new NotFoundError('Unknown job')

    return withTenant({ organizationId: job.organizationId }, () => fireScheduledJob(job))
  },
  { tenancy: { fromPayload: 'the job row named by body.scheduleId' } }
)
