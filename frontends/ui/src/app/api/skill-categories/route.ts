/**
 * Skill categories API — the org's own arrangement. Thin adapters (ADR-0017);
 * logic in `@/lib/skills/service`. Every query is org-scoped, and platform
 * categories are read-only here: they arrive inside the list, and nothing else.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { createSkillCategory, listSkillCategories } from '@/lib/skills/service'
import { createCategorySchema } from '@/lib/skills/types'

export const GET = apiRoute(
  async ({ session }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return listSkillCategories(session)
  },
  {
    authz: {
      enforcedBy: 'listSkillCategories (org member)',
    },
  }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const input = await parseJsonBody(request, createCategorySchema)
    const result = await createSkillCategory(session, input)
    return Response.json(result, { status: 201 })
  },
  {
    authz: {
      enforcedBy: 'createSkillCategory (org:skills:manage)',
    },
  }
)
