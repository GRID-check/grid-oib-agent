/**
 * Platform → Skills: the fleet-wide catalogue (ADR-0016).
 *
 * Platform owners only, no per-org feature flag: this is the layer *under*
 * every tenant's skill list, not a tenant capability. A row written here reaches
 * every organization at once, and `delivery` says how: an `offer` lands on each
 * org's Skills tab for it to switch on (`PATCH /api/skills/curated/{name}`),
 * while a `standard` skill simply runs for all of them — unlisted, unswitchable
 * and unshadowable, ours to publish and ours to withdraw.
 *
 * GET  — the whole catalogue, drafts included.
 * POST — add one. Created as a DRAFT and as an OFFER unless told otherwise. Both
 *        defaults are closed and they close different doors: unpublished is
 *        invisible, `offer` requires consent. So the dashboard is usable as a
 *        writing surface, and imposing an instruction on the whole fleet takes
 *        two deliberate words rather than one absent-minded save.
 */

import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { createPlatformSkill, listPlatformSkills } from '@/lib/skills/platform-service'
import { createPlatformSkillSchema } from '@/lib/skills/types'

export const GET = platformApiRoute(async () => listPlatformSkills(), {
  permission: PLATFORM_PERMISSIONS.settingsView,
})

export const POST = platformApiRoute(
  async ({ request, session }) => {
    const input = await parseJsonBody(request, createPlatformSkillSchema)
    return createPlatformSkill(input, {
      userId: session.userId,
      email: session.email ?? null,
    })
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
