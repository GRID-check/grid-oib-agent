import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import {
  enabledPostAnswerStages,
  isDeepResearchEnabledForOrg,
  isTaskAutomationEnabledForOrg,
} from '@/lib/workos/feature-flags'

/**
 * INTERNAL service endpoint — the per-TURN read of what a tenant's turn may do:
 * which post-answer stages are switched on, and which capabilities the agent is
 * allowed to OFFER.
 *
 * The decision used to be made once, at the WebSocket upgrade, and forwarded as
 * `x-grid-feature-memory-reflection`. That header is then frozen for the life of
 * the socket, so turning a stage off did not reach an already-open tab — the
 * opposite of what an operator reaching for a kill switch believes. The backend
 * calls this at the start of each turn instead, the same way it re-reads the
 * project-memory digest (`GET /api/internal/memory/digest`) rather than trusting
 * the connection-time header, and falls back to that header only when this call
 * fails.
 *
 * `features` rides the same call rather than earning an endpoint of its own.
 * The agent resolves it in the same per-turn gather, on the critical path,
 * under one 1.5s timeout; a second round-trip would buy a second way for that
 * budget to be spent and nothing else. `deepResearch` is the first entry: the
 * flag gating `POST /api/jobs/async/submit` closed the job queue while the
 * agent went on escalating into it, so the run was refused only after the
 * reader had approved a plan for it. `tasks` is the same defect one door along:
 * the Automation section can be hidden and `create_task` still hands work over
 * from a chat turn.
 *
 * Reads feature flags and environment only — no tenant data — so it opens no
 * database scope. Token-guarded like every other internal route.
 */

const querySchema = z.object({
  organizationId: z
    .string()
    .regex(/^org_[A-Za-z0-9]+$/, 'not a WorkOS organization id')
    .optional(),
})

export const GET = internalApiRoute(
  'post-answer-stages',
  async ({ request }) => {
    const { organizationId } = parseQuery(request, querySchema)
    const [enabled, deepResearch, tasks] = await Promise.all([
      enabledPostAnswerStages(organizationId),
      isDeepResearchEnabledForOrg(organizationId),
      isTaskAutomationEnabledForOrg(organizationId),
    ])
    return { enabled, features: { deepResearch, tasks } }
  },
  // `?organizationId` names the tenant the flags are evaluated for. No query
  // runs, so no scope is opened; a query added here later would throw rather
  // than read across tenants.
  { tenancy: { fromPayload: '?organizationId' } }
)
