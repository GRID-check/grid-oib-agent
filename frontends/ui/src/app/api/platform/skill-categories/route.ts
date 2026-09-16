/**
 * Platform → Skill categories: the fleet catalogue's arrangement (ADR-0016).
 *
 * Platform owners only, no per-org feature flag: this is the layer *under*
 * every tenant's category list. A category written here is read by every
 * organization at once; an org skill may stand on one, and builtin file
 * offers resolve their collection against these slugs.
 *
 * GET  — the platform categories.
 * POST — add one. Names are unique among platform categories.
 */

import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { createPlatformSkillCategory, listPlatformSkillCategories } from '@/lib/skills/platform-service'
import { createCategorySchema } from '@/lib/skills/types'

export const GET = platformApiRoute(async () => listPlatformSkillCategories(), {
  permission: PLATFORM_PERMISSIONS.settingsView,
})

export const POST = platformApiRoute(
  async ({ request, session }) => {
    const input = await parseJsonBody(request, createCategorySchema)
    return createPlatformSkillCategory(input, {
      userId: session.userId,
      email: session.email ?? null,
    })
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
