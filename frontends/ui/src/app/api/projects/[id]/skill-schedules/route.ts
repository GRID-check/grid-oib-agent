/**
 * Skill schedules API — project-scoped schedule list + create. Thin adapters
 * (ADR-0017); logic in `@/lib/skills/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { createSkillSchedule, listSkillSchedules } from '@/lib/skills/service'
import { createSkillScheduleSchema } from '@/lib/skills/types'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return listSkillSchedules(session, params.id)
  },
  {
    authz: {
      enforcedBy: 'listSkillSchedules (requireProjectAccess project:view)',
    },
  }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const input = await parseJsonBody(request, createSkillScheduleSchema)
    const schedule = await createSkillSchedule(session, params.id, input)
    return Response.json({ schedule }, { status: 201 })
  },
  {
    authz: {
      enforcedBy: 'createSkillSchedule (requireProjectAccess project:skills:manage)',
    },
  }
)