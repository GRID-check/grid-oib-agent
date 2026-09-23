/**
 * A plan a person writes: „Auftrag planen". The plan is created approved —
 * the person who wrote it is the person who would have approved it — and
 * its run is commissioned in the same step, so the block appears in the
 * thread at once and the worker starts at its next claim.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { researchPlanDraftSchema } from '@/lib/plans/plan-types'
import { proposePlannedRun } from '@/lib/plans/service'

type Params = { id: string }

const createPlanSchema = researchPlanDraftSchema.extend({
  conversationId: z.string().trim().min(1).max(64),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { conversationId, ...draft } = await parseJsonBody(request, createPlanSchema)
    return proposePlannedRun(session, {
      projectId: params.id,
      conversationId,
      draft,
      author: 'user',
      start: 'approved',
    })
  },
  {
    status: 201,
    authz: { enforcedBy: 'proposePlannedRun (requireProjectAccess COMMISSION_PERMISSIONS)' },
  }
)
