/**
 * Skill-schedule run history API — newest-first submission history for one
 * schedule. Read permission required; paginated via ?limit&offset.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { listSkillRunsForSchedule } from '@/lib/skills/service'
import { listRunsQuerySchema } from '@/lib/skills/types'

type Params = { id: string; scheduleId: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const { limit, offset } = parseQuery(request, listRunsQuerySchema)
    return listSkillRunsForSchedule(session, params.id, params.scheduleId, limit, offset)
  },
  {
    authz: {
      enforcedBy: 'listSkillRunsForSchedule (requireProjectAccess project:view)',
    },
  }
)