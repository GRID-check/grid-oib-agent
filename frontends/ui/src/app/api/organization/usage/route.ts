/**
 * LLM usage summary in CREDITS (per-model day/month breakdown for the budget
 * UI). The platform's cost never leaves the service's tenant projection
 * (ADR-0053).
 *
 * Budget admins see the org-wide summary (optionally narrowed with ?userId= /
 * ?projectId=); non-admin members always get their own usage only. Thin
 * handler; scoping lives in `@/lib/budgets/service`.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { getUsageOverview } from '@/lib/budgets/service'

const querySchema = z.object({
  userId: z.string().optional(),
  projectId: z.string().optional(),
})

export const GET = apiRoute(
  async ({ session, request }) => getUsageOverview(session, parseQuery(request, querySchema)),
  { authz: { enforcedBy: 'getUsageOverview (canManageBudgets, else own usage only)' } }
)
