/**
 * Manual "Run now" API — fires a skill schedule immediately via the shared
 * fireSkillSchedule path. Edit permission required; 409 when the schedule is
 * disabled; a backend admission cap (429) surfaces as a friendly `skipped` run.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { runSkillScheduleNow } from '@/lib/skills/service'

type Params = { id: string; scheduleId: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return runSkillScheduleNow(session, params.id, params.scheduleId)
  },
  {
    authz: {
      enforcedBy: 'runSkillScheduleNow (requireProjectAccess project:skills:manage)',
    },
  }
)