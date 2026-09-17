/**
 * Tasks API — a project's delegated work, newest first (ADR-0051). Thin
 * adapter; logic in `@/lib/tasks/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { listTaskViews } from '@/lib/tasks/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    // Projected explicitly: a drizzle row carries `Date`s and a plan whose
    // prompt is a skill's whole body, and neither belongs on this wire.
    return { tasks: await listTaskViews(session, params.id) }
  },
  {
    authz: {
      enforcedBy: 'listTaskViews -> listTasks (requireProjectAccess project:view)',
    },
  }
)
