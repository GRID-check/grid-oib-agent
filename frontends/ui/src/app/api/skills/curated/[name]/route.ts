/**
 * A platform-curated skill's activation for this organization
 * (`PATCH /api/skills/curated/[name]` with `{ enabled }`).
 *
 * Addressed by NAME, unlike every other skill route, because a platform skill
 * has no id: it is a file under `src/aiq_agent/skills/builtin/`, and what is
 * stored is only the organization's decision about it
 * (`curated_skill_activations`).
 *
 * Only CURATED names are addressable — the service 404s the pipeline's own
 * machinery rather than letting anyone switch off how deep research writes its
 * report. Thin adapter (ADR-0017); the rule lives in `@/lib/skills/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { setCuratedSkillEnabled } from '@/lib/skills/service'
import { curatedSkillActivationSchema } from '@/lib/skills/types'

type Params = { name: string }

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const { enabled } = await parseJsonBody(request, curatedSkillActivationSchema)
    return setCuratedSkillEnabled(session, decodeURIComponent(params.name), enabled)
  },
  {
    authz: {
      enforcedBy: 'setCuratedSkillEnabled (org:skills:manage)',
    },
  }
)
