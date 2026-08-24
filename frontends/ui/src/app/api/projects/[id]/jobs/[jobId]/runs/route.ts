/**
 * Job run-history API — newest-first submission history for one job. Read
 * permission required; paginated via ?limit&offset.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { listJobRuns } from '@/lib/jobs/service'
import { listRunsQuerySchema } from '@/lib/jobs/types'

type Params = { id: string; jobId: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const { limit, offset } = parseQuery(request, listRunsQuerySchema)
    return listJobRuns(session, params.id, params.jobId, limit, offset)
  },
  {
    authz: {
      enforcedBy: 'listJobRuns (requireProjectAccess project:view)',
    },
  }
)
