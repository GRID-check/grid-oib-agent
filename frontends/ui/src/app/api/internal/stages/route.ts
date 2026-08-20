import { z } from 'zod'
import { internalApiRoute, parseQuery } from '@/lib/api/handler'
import { enabledPostAnswerStages } from '@/lib/workos/feature-flags'

/**
 * INTERNAL service endpoint — the per-TURN read of which post-answer stages are
 * switched on for a tenant.
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
    return { enabled: await enabledPostAnswerStages(organizationId) }
  },
  // `?organizationId` names the tenant the flags are evaluated for. No query
  // runs, so no scope is opened; a query added here later would throw rather
  // than read across tenants.
  { tenancy: { fromPayload: '?organizationId' } }
)
