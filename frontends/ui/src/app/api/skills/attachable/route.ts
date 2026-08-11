/**
 * The job builder's skill picker — the skills a job with this output kind may
 * attach (`GET /api/skills/attachable?output=chat|deep-research`).
 *
 * `chat` runs on `shallow_researcher` and `deep-research` on `deep_researcher`,
 * and availability comes from `grid-agents` — the one gate. Offering a skill
 * the chosen output cannot run would be offering a job that fails at fire time,
 * which is precisely what consolidating availability onto that key prevents.
 *
 * Thin adapter (ADR-0017); the resolution lives in `@/lib/jobs/service`. Any
 * org member may read it: picking a skill is using the product, not
 * administering it.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { listAttachableSkills } from '@/lib/jobs/service'
import { attachableSkillsQuerySchema } from '@/lib/jobs/types'

export const GET = apiRoute(
  async ({ session, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const { output } = parseQuery(request, attachableSkillsQuerySchema)
    return listAttachableSkills(session, output)
  },
  {
    authz: {
      enforcedBy: 'listAttachableSkills (org member — attaching a skill is use, not administration)',
    },
  }
)
