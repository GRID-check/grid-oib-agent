/**
 * Review a finished task: accept it, or reject it with a reason the next run
 * of the same job is told (ADR-0051). Thin adapter; logic in
 * `@/lib/tasks/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { reviewTask } from '@/lib/tasks/service'
import { reviewTaskSchema } from '@/lib/tasks/types'

type Params = { id: string; taskId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const input = await parseJsonBody(request, reviewTaskSchema)
    return { task: await reviewTask(session, params.id, params.taskId, input, request) }
  },
  {
    authz: {
      enforcedBy: 'reviewTask (requireProjectAccess project:edit)',
    },
  }
)
