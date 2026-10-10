import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import {
  enabledPostAnswerStages,
  isDeepResearchEnabledForOrg,
  isTaskAutomationEnabledForOrg,
} from '@/lib/workos/feature-flags'
import { findProjectTenancy } from '@/lib/projects/repository'
import { isProjectClosed } from '@/lib/projects/project-status'

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
 * `?projectId` names the turn's project. A CLOSED project (ADR-0090) withdraws
 * both capabilities: a research run and a task each file into the project,
 * which is read-only, so the agent must not offer what the BFF would refuse
 * after the reader approved it. The project is read by the same tenancy probe
 * every authorization uses, and only counts when it belongs to
 * `?organizationId`.
 *
 * Token-guarded like every other internal route.
 */

const querySchema = z.object({
  organizationId: z
    .string()
    .regex(/^org_[A-Za-z0-9]+$/, 'not a WorkOS organization id')
    .optional(),
  projectId: z.string().uuid().optional(),
})

export const GET = internalApiRoute(
  'post-answer-stages',
  async ({ request }) => {
    const { organizationId, projectId } = parseQuery(request, querySchema)
    const [enabled, deepResearch, tasks, project] = await Promise.all([
      enabledPostAnswerStages(organizationId),
      isDeepResearchEnabledForOrg(organizationId),
      isTaskAutomationEnabledForOrg(organizationId),
      projectId ? findProjectTenancy(projectId) : Promise.resolve(null),
    ])
    const closed = project !== null && project.organizationId === organizationId && isProjectClosed(project)
    return { enabled, features: { deepResearch: deepResearch && !closed, tasks: tasks && !closed } }
  },
  // `?organizationId` names the tenant the flags are evaluated for. The one
  // query, the project's tenancy probe, states its own platform scope and is
  // then held to that tenant; any other query added here would throw rather
  // than read across tenants.
  { tenancy: { fromPayload: '?organizationId' } }
)
