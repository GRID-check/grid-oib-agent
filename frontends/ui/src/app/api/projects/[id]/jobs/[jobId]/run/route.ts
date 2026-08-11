/**
 * Manual "Run now" API — fires a job immediately via the shared `fireJob`
 * path. Edit permission required; 409 when the job is disabled; a backend
 * admission cap (429) surfaces as a friendly `skipped` run.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { runJobNow } from '@/lib/jobs/service'

type Params = { id: string; jobId: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return runJobNow(session, params.id, params.jobId)
  },
  {
    authz: {
      enforcedBy: 'runJobNow (requireProjectAccess project:skills:manage)',
    },
  }
)
