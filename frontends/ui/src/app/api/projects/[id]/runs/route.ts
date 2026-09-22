/**
 * Commission a research run from the UI: an open finding to clear, or a
 * report to carry forward. An adapter over `commissionResearchRun`, the
 * same door the agent's own escalation uses (ADR-0062 addendum), with the
 * same gate; the run's message is minted in the thread that asked.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { TASK_GOAL_MAX_CHARS } from '@/lib/tasks/delegation'
import { commissionResearchRun } from '@/lib/tasks/delegation'

type Params = { id: string }

const commissionRunSchema = z.object({
  conversationId: z.string().min(1),
  question: z.string().trim().min(1).max(TASK_GOAL_MAX_CHARS),
  context: z.string().trim().max(20_000).optional(),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, commissionRunSchema)
    const run = await commissionResearchRun(session, {
      projectId: params.id,
      conversationId: input.conversationId,
      question: input.question,
      context: input.context ?? null,
    })
    return {
      runId: run.runId,
      runMessageId: run.runMessageId,
      conversationId: run.conversationId,
      status: run.status,
    }
  },
  {
    status: 201,
    authz: {
      enforcedBy: 'commissionResearchRun (requireProjectAccess COMMISSION_PERMISSIONS)',
    },
  }
)
