/**
 * Single-workflow API — get, patch (recompiles + recomputes next_run_at), and
 * delete. Thin adapters (ADR-0017); logic in `@/lib/workflows/service`. Every
 * query double-filters by organization_id in the service/repository layers.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireWorkflowsEnabled } from '@/lib/authz/feature-flags'
import { deleteWorkflow, getWorkflow, updateWorkflow } from '@/lib/workflows/service'
import { patchWorkflowSchema } from '@/lib/workflows/types'

type Params = { id: string; workflowId: string }

export const GET = apiRoute<Params>(async ({ session, params }) => {
  const gated = requireWorkflowsEnabled(session)
  if (gated) return gated
  return getWorkflow(session, params.id, params.workflowId)
})

export const PATCH = apiRoute<Params>(async ({ session, params, request }) => {
  const gated = requireWorkflowsEnabled(session)
  if (gated) return gated
  const patch = await parseJsonBody(request, patchWorkflowSchema)
  return updateWorkflow(session, params.id, params.workflowId, patch)
})

export const DELETE = apiRoute<Params>(async ({ session, params }) => {
  const gated = requireWorkflowsEnabled(session)
  if (gated) return gated
  await deleteWorkflow(session, params.id, params.workflowId)
})
