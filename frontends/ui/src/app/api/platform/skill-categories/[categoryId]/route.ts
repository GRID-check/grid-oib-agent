/**
 * One platform skill category (ADR-0016). Platform owners only.
 *
 * PATCH  — rename, re-describe, re-order it. Renaming never detaches the
 *          builtin file offers: they resolve to a category by slug, not by the
 *          display name. Deleting a seeded category unassigns them (they read
 *          as unsorted) — removing the category removes the mapping.
 * DELETE — remove it. Skills standing on it fall back to unsorted; the skills
 *          themselves are untouched.
 */

import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { deletePlatformCategory, updatePlatformCategory } from '@/lib/skills/platform-service'
import { patchCategorySchema } from '@/lib/skills/types'

type Params = { categoryId: string }

export const PATCH = platformApiRoute<Params>(
  async ({ request, params }) => {
    const patch = await parseJsonBody(request, patchCategorySchema)
    return updatePlatformCategory(params.categoryId, patch)
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)

export const DELETE = platformApiRoute<Params>(
  async ({ params }) => deletePlatformCategory(params.categoryId),
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
