/**
 * Single org-skill API — patch and delete for the org toolbox. Thin adapters
 * (ADR-0017); logic in `@/lib/skills/service`. Every query is org-scoped.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { deleteSkill, updateSkill } from '@/lib/skills/service'
import { patchSkillSchema } from '@/lib/skills/types'

type Params = { skillId: string }

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const patch = await parseJsonBody(request, patchSkillSchema)
    return updateSkill(session, params.skillId, patch)
  },
  {
    authz: {
      enforcedBy: 'updateSkill (org:skills:manage)',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    await deleteSkill(session, params.skillId)
  },
  {
    authz: {
      enforcedBy: 'deleteSkill (org:skills:manage)',
    },
  }
)