/**
 * Single org shelf API — rename, re-describe, re-order, remove. Thin adapters
 * (ADR-0017); logic in `@/lib/skills/service`. Platform shelves 404 here: the
 * fleet's arrangement is curated in Platform → Skills, never from a tenant.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { deleteSkillCategory, updateSkillCategory } from '@/lib/skills/service'
import { patchCategorySchema } from '@/lib/skills/types'

type Params = { categoryId: string }

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const patch = await parseJsonBody(request, patchCategorySchema)
    return updateSkillCategory(session, params.categoryId, patch)
  },
  {
    authz: {
      enforcedBy: 'updateSkillCategory (org:skills:manage)',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    await deleteSkillCategory(session, params.categoryId)
  },
  {
    authz: {
      enforcedBy: 'deleteSkillCategory (org:skills:manage)',
    },
  }
)
