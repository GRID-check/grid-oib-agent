/**
 * Workflow run history API — newest-first submission history for one workflow.
 * Read permission required; paginated via ?limit&offset.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { requireWorkflowsEnabled } from '@/lib/authz/feature-flags'
import { listRuns } from '@/lib/workflows/service'
import { listRunsQuerySchema } from '@/lib/workflows/types'

type Params = { id: string; workflowId: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireWorkflowsEnabled(session)
    if (gated) return gated
    const { limit, offset } = parseQuery(request, listRunsQuerySchema)
    return { runs: await listRuns(session, params.id, params.workflowId, { limit, offset }) }
  },
  { authz: { enforcedBy: 'listRuns (requireProjectAccess project:view)' } }
)
