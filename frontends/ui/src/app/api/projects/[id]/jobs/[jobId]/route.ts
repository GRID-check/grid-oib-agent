/**
 * Single job API — get, patch (re-resolves the attached skill when it changed
 * and recomputes next_run_at), delete. Thin adapters (ADR-0017); logic in
 * `@/lib/jobs/service`. Every query is org-scoped.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { deleteJob, getJob, updateJob } from '@/lib/jobs/service'
import { patchJobSchema } from '@/lib/jobs/types'

type Params = { id: string; jobId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return getJob(session, params.id, params.jobId)
  },
  {
    authz: {
      enforcedBy: 'getJob (requireProjectAccess project:view)',
    },
  }
)

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const patch = await parseJsonBody(request, patchJobSchema)
    return updateJob(session, params.id, params.jobId, patch)
  },
  {
    authz: {
      enforcedBy: 'updateJob (requireProjectAccess project:skills:manage)',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    await deleteJob(session, params.id, params.jobId)
  },
  {
    authz: {
      enforcedBy: 'deleteJob (requireProjectAccess project:skills:manage)',
    },
  }
)
