/**
 * Tasks API — a project's delegated work, newest first (ADR-0051). Thin
 * adapter; logic in `@/lib/tasks/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { listTasks } from '@/lib/tasks/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return { tasks: await listTasks(session, params.id) }
  },
  {
    authz: {
      enforcedBy: 'listTasks (requireProjectAccess project:view)',
    },
  }
)
