/**
 * Tasks API — a project's delegated work, newest first (ADR-0051). Thin
 * adapter; logic in `@/lib/tasks/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireSkillsEnabled, requireTaskAutomationEnabled } from '@/lib/authz/feature-flags'
import { listTaskViews } from '@/lib/tasks/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    // Both, and they are not redundant. `skills` decides whether the Automation
    // section exists; `task-automation` decides whether work may be queued at
    // all. An org can have the published toolbox in chat without the right to
    // hand work over, which is the whole reason the second flag exists — so
    // re-enabling the section must not quietly bring tasks back with it.
    const gated = requireSkillsEnabled(session) ?? requireTaskAutomationEnabled(session)
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
