/**
 * Single skill-schedule API — get, patch (re-resolves the skill when it
 * changed and recomputes next_run_at), delete. Thin adapters (ADR-0017);
 * logic in `@/lib/skills/service`. Every query is org-scoped.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import {
  deleteSkillSchedule,
  getSkillSchedule,
  updateSkillSchedule,
} from '@/lib/skills/service'
import { patchSkillScheduleSchema } from '@/lib/skills/types'

type Params = { id: string; scheduleId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return getSkillSchedule(session, params.id, params.scheduleId)
  },
  {
    authz: {
      enforcedBy: 'getSkillSchedule (requireProjectAccess project:view)',
    },
  }
)

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const patch = await parseJsonBody(request, patchSkillScheduleSchema)
    return updateSkillSchedule(session, params.id, params.scheduleId, patch)
  },
  {
    authz: {
      enforcedBy: 'updateSkillSchedule (requireProjectAccess project:skills:manage)',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    await deleteSkillSchedule(session, params.id, params.scheduleId)
  },
  {
    authz: {
      enforcedBy: 'deleteSkillSchedule (requireProjectAccess project:skills:manage)',
    },
  }
)