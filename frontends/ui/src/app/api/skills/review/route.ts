/**
 * Skill review — ask the backend reviewer what is wrong with a skill draft.
 *
 * Thin adapter (ADR-0017); the backend call and its fail-open contract live in
 * `@/lib/skills/review`. Always resolves to 200 with `{ findings, error? }`:
 * the editor treats a null `findings` as "no review this time" and never blocks
 * a save on it.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { reviewSkill } from '@/lib/skills/review'
import { MAX_SKILL_BODY_LENGTH, MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_NAME_LENGTH } from '@/lib/skills/types'

/**
 * Deliberately looser than `createSkillSchema`: the whole point is to review a
 * DRAFT, and a draft is usually not yet valid. Only the outer bounds are
 * enforced, so the reviewer can be asked about an empty description — which is
 * exactly the case where its answer matters most.
 */
const reviewSkillSchema = z.object({
  name: z.string().max(MAX_SKILL_NAME_LENGTH).default(''),
  description: z.string().max(MAX_SKILL_DESCRIPTION_LENGTH).default(''),
  body: z.string().max(MAX_SKILL_BODY_LENGTH).default(''),
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const input = await parseJsonBody(request, reviewSkillSchema)
    return reviewSkill(session, input)
  },
  {
    authz: {
      enforcedBy: 'reviewSkill (org member — reviewing a draft is not a privileged action)',
    },
  }
)
