/**
 * The composer's `/` menu — the skills this member may invoke in a chat turn.
 *
 * Progressive-disclosure level 1 only (name + description, no bodies): the same
 * catalogue the agent itself is given at turn start. Thin adapter (ADR-0017);
 * the filtering lives in `@/lib/skills/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { listInvocableSkills } from '@/lib/skills/service'

export const GET = apiRoute(
  async ({ session }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return listInvocableSkills(session)
  },
  {
    authz: {
      enforcedBy: 'listInvocableSkills (org member — invoking is use, not administration)',
    },
  }
)
