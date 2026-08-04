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
import { NotFoundError } from '@/lib/api/errors'
import { fireScheduledWorkflow, loadWorkflowForFire } from '@/lib/workflows/service'
import { internalFireSchema } from '@/lib/workflows/types'

export const POST = internalApiRoute(
  'Workflow Fire',
  async ({ request }) => {
    const { workflowId } = await parseJsonBody(request, internalFireSchema)

    const workflow = await loadWorkflowForFire(workflowId)
    if (!workflow) throw new NotFoundError('Unknown workflow')

    return fireScheduledWorkflow(workflow)
  },
  {
    tenancy: {
      // The scheduler holds a workflow id and no organization — the row is what
      // names its tenant. `fireScheduledWorkflow` re-reads `enabled` and the
      // org's feature gate from that row, so tenancy is decided from stored
      // state rather than from anything the caller supplied.
      crossTenant: 'the scheduler identifies work by workflow id, before any organization is known',
    },
  }
)
