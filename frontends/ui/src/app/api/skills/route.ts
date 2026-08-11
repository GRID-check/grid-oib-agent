/**
 * Skills toolbox API — merged builtin+org list and org skill authoring. Thin
 * adapters (ADR-0017); logic in `@/lib/skills/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { createSkill, listSkills } from '@/lib/skills/service'
import { createSkillSchema } from '@/lib/skills/types'

export const GET = apiRoute(
  async ({ session }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return listSkills(session)
  },
  {
    authz: {
      enforcedBy: 'listSkills (org member)',
    },
  }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const input = await parseJsonBody(request, createSkillSchema)
    const result = await createSkill(session, input)
    return Response.json(result, { status: 201 })
  },
  {
    authz: {
      enforcedBy: 'createSkill (org:skills:manage)',
    },
  }
)
