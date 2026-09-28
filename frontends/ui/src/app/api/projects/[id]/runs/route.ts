/**
 * Commission a research run from the UI: an open finding to clear, or a
 * report to carry forward. An adapter over `commissionResearchRun`, the
 * same door the agent's own escalation uses (ADR-0062 addendum), with the
 * same gate; the run's message is minted in the thread that asked.
 */

import { z } from 'zod'
import { planDocumentsSchema } from '@/lib/runs/plan-documents'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { NotFoundError } from '@/lib/api/errors'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { TASK_GOAL_MAX_CHARS } from '@/lib/tasks/delegation'
import { commissionResearchRun } from '@/lib/tasks/delegation'

type Params = { id: string }

const commissionRunSchema = z.object({
  conversationId: z.string().min(1),
  question: z.string().trim().min(1).max(TASK_GOAL_MAX_CHARS),
  context: z.string().trim().max(20_000).optional(),
  /** The Unterlagen a continuation carries forward: the last report's sources as its Grundlage. */
  documents: planDocumentsSchema.optional(),
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    // The same capability `POST /api/jobs/async/submit` and the agent's door
    // (`api/internal/tasks`) gate: a third way in must not be the way around it.
    const gated = requireFeature(session, FEATURE_FLAGS.deepResearch)
    if (gated) return gated
    const input = await parseJsonBody(request, commissionRunSchema)
    // The internal route takes the thread from a signed envelope; here it is a
    // body field, so it is authorized like any other post to a thread: the
    // caller contributes to it, and it belongs to the project in the path.
    await requireResourceAccess(session, 'conversation', input.conversationId, 'collaborator')
    const conversation = await findConversationInOrg(input.conversationId, session.organizationId)
    if (conversation?.projectId !== params.id) throw new NotFoundError()
    const run = await commissionResearchRun(session, {
      projectId: params.id,
      conversationId: input.conversationId,
      question: input.question,
      context: input.context ?? null,
      documents: input.documents ?? null,
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
      enforcedBy:
        'requireFeature deepResearch; requireResourceAccess conversation collaborator; commissionResearchRun (requireProjectAccess COMMISSION_PERMISSIONS)',
    },
  }
)
