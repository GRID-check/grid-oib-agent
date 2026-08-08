/**
 * Manual "Run now" API — fires a workflow immediately via the shared
 * fireWorkflow path. Edit permission required; 409 when the workflow is
 * disabled; a backend admission cap (429) surfaces as a friendly `skipped` run.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireWorkflowsEnabled } from '@/lib/authz/feature-flags'
import { runWorkflowNow } from '@/lib/workflows/service'

type Params = { id: string; workflowId: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireWorkflowsEnabled(session)
    if (gated) return gated
    return { run: await runWorkflowNow(session, params.id, params.workflowId) }
  },
  { authz: { enforcedBy: 'runWorkflowNow (requireProjectAccess project:workflows:manage)' } }
)
