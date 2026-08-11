/**
 * Jobs API — project-scoped job list + create. Thin adapters (ADR-0017);
 * logic in `@/lib/jobs/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { createJob, listJobs } from '@/lib/jobs/service'
import { createJobSchema } from '@/lib/jobs/types'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return listJobs(session, params.id)
  },
  {
    authz: {
      enforcedBy: 'listJobs (requireProjectAccess project:view)',
    },
  }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const input = await parseJsonBody(request, createJobSchema)
    const job = await createJob(session, params.id, input)
    return Response.json({ job }, { status: 201 })
  },
  {
    authz: {
      enforcedBy: 'createJob (requireProjectAccess project:skills:manage)',
    },
  }
)
