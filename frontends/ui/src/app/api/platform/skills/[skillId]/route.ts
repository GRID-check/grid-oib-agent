/**
 * One curated skill (ADR-0016). Platform owners only.
 *
 * PATCH  — edit it, including publishing and withdrawing (`published`). An edit
 *          reaches every organization running the skill immediately: the body
 *          lives here and only here, so no organization holds a copy that can
 *          fall out of date.
 *
 *          Nothing here decides FOR an organization: a row is offered, and the
 *          organization always decides whether to run it, including when it has
 *          switched the skill off.
 * DELETE — withdraw it from the fleet. Organizations stop resolving it; their
 *          activation rows are left alone, so re-creating the skill under the
 *          same name restores the fleet as it was.
 */

import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { deletePlatformSkill, updatePlatformSkill } from '@/lib/skills/platform-service'
import { patchPlatformSkillSchema } from '@/lib/skills/types'

type Params = { skillId: string }

export const PATCH = platformApiRoute<Params>(
  async ({ request, params }) => {
    const patch = await parseJsonBody(request, patchPlatformSkillSchema)
    return updatePlatformSkill(params.skillId, patch)
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)

export const DELETE = platformApiRoute<Params>(
  async ({ params }) => deletePlatformSkill(params.skillId),
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
