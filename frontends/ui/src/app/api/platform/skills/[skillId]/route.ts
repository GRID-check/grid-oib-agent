/**
 * One curated skill (ADR-0016). Platform owners only.
 *
 * PATCH  — edit it, including publishing and withdrawing (`published`). An edit
 *          reaches every organization that switched the skill on, immediately:
 *          the body lives here and only here, which is the property the removed
 *          "clone a platform skill" flow could not have.
 * DELETE — withdraw it from the fleet. Organizations stop resolving it; their
 *          activation rows are left alone, so re-creating the skill under the
 *          same name restores the fleet as it was.
 */

import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { deletePlatformSkill, updatePlatformSkill } from '@/lib/skills/platform-service'
import { patchPlatformSkillSchema } from '@/lib/skills/types'

type Params = { skillId: string }

export const PATCH = platformApiRoute<Params>(
  async ({ request, params }) => {
    const patch = await parseJsonBody(request, patchPlatformSkillSchema)
    return updatePlatformSkill(params.skillId, patch)
  }
)

export const DELETE = platformApiRoute<Params>(
  async ({ params }) => deletePlatformSkill(params.skillId)
)
