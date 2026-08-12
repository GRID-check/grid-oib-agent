/**
 * Platform → Skills: the fleet-wide curated catalogue (ADR-0016).
 *
 * Platform owners only, no per-org feature flag: this is the layer *under*
 * every tenant's skill list, not a tenant capability. A row written here is
 * offered to every organization at once; each decides whether to switch it on
 * (`PATCH /api/skills/curated/{name}`).
 *
 * GET  — the whole catalogue, drafts included.
 * POST — add one. Created as a DRAFT unless `published` says otherwise, so the
 *        dashboard can be used as a writing surface.
 */

import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { createPlatformSkill, listPlatformSkills } from '@/lib/skills/platform-service'
import { createPlatformSkillSchema } from '@/lib/skills/types'

export const GET = platformApiRoute(
  async () => listPlatformSkills()
)

export const POST = platformApiRoute(
  async ({ request, session }) => {
    const input = await parseJsonBody(request, createPlatformSkillSchema)
    return createPlatformSkill(input, {
      userId: session.userId,
      email: session.email ?? null,
    })
  }
)
