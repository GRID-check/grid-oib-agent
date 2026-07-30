/**
 * Workflows collection API — list a project's workflows and create new ones.
 * Thin transport adapters (ADR-0017); logic + authorization live in
 * `@/lib/workflows/service`. Feature-gated by the dark-launch workflows gate.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireWorkflowsEnabled } from '@/lib/authz/feature-flags'
import { createWorkflow, listWorkflows } from '@/lib/workflows/service'
import { createWorkflowSchema } from '@/lib/workflows/types'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireWorkflowsEnabled(session)
    if (gated) return gated
    return { workflows: await listWorkflows(session, params.id) }
  },
  { authz: { enforcedBy: 'listWorkflows (requireProjectAccess project:view)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireWorkflowsEnabled(session)
    if (gated) return gated
    const input = await parseJsonBody(request, createWorkflowSchema)
    return createWorkflow(session, params.id, input)
  },
  {
    status: 201,
    authz: { enforcedBy: 'createWorkflow (requireProjectAccess project:workflows:manage)' },
  }
)
