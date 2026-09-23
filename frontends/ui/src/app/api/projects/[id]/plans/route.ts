/**
 * A plan a person writes: „Recherche planen". The plan is created approved —
 * the person who wrote it is the person who would have approved it — and
 * its run is commissioned in the same step, so the block appears in the
 * thread at once and the worker starts at its next claim. A plan carried
 * forward rather than written (`countdown`) starts after the usual grace.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { researchPlanDraftSchema } from '@/lib/plans/plan-types'
import { proposePlannedRun } from '@/lib/plans/service'
import { RESEARCH_CONTEXT_MAX_CHARS } from '@/lib/tasks/wire'

type Params = { id: string }

const createPlanSchema = researchPlanDraftSchema.extend({
  conversationId: z.string().trim().min(1).max(64),
  /** What the run is told beside the plan: a continuation's earlier findings. */
  context: z.string().trim().min(1).max(RESEARCH_CONTEXT_MAX_CHARS).optional(),
  /**
   * Start after the usual countdown instead of at once: a plan the reader did
   * not write line by line — „Bericht fortschreiben" carries the last plan
   * forward — is shown on the block first, like the agent's.
   */
  countdown: z.boolean().optional(),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { conversationId, context, countdown, ...draft } = await parseJsonBody(request, createPlanSchema)
    return proposePlannedRun(session, {
      projectId: params.id,
      conversationId,
      draft,
      author: 'user',
      start: countdown ? { policy: 'auto' } : 'approved',
      context: context ?? null,
    })
  },
  {
    status: 201,
    authz: { enforcedBy: 'proposePlannedRun (requireProjectAccess COMMISSION_PERMISSIONS)' },
  }
)
