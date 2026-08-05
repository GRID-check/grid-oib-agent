/**
 * INTERNAL fire endpoint — the scheduler POSTs `{ workflowId }` here after it
 * has claimed a due row and advanced its next_run_at. Shared-token guarded
 * (GRID_INTERNAL_API_TOKEN via `internalApiRoute`, like /api/internal/memory).
 *
 * Loads the workflow with NO session (the scheduler has none) and delegates to
 * `fireScheduledWorkflow`, which re-checks `enabled` (the row may have been
 * disabled since the claim) and the org's `workflows` feature gate before
 * firing through the single `fireWorkflow` path.
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { NotFoundError } from '@/lib/api/errors'
import { fireScheduledWorkflow, loadWorkflowForFire } from '@/lib/workflows/service'
import { internalFireSchema } from '@/lib/workflows/types'

export const POST = internalApiRoute(
  'Workflow Fire',
  async ({ request }) => {
    const { workflowId } = await parseJsonBody(request, internalFireSchema)

    // Narrow on purpose: the BYPASS covers only the lookup that genuinely has
    // no tenant yet. Everything the run then does — recording the run, reading
    // budgets, building the project scope — is one organization's work and is
    // done as that organization, so row-level security still applies to it.
    // Wrapping the whole fire instead would silently exempt every scheduled run
    // from the boundary this feature exists to enforce.
    const workflow = await withPlatformAccess(
      'workflow fire: the scheduler identifies work by id, before any organization is known',
      () => loadWorkflowForFire(workflowId)
    )
    if (!workflow) throw new NotFoundError('Unknown workflow')

    return withTenant({ organizationId: workflow.organizationId }, () =>
      fireScheduledWorkflow(workflow)
    )
  },
  { tenancy: { fromPayload: 'the workflow row named by body.workflowId' } }
)
