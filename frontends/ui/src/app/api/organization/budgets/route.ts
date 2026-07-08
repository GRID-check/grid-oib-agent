/**
 * LLM budget policies.
 *
 * GET — members see the org limits + their own member limit; budget admins
 *       additionally get every active member/project policy.
 * PUT — sets a policy. Org and member scopes: budget admins only. Project
 *       scope: budget admins or that project's admins.
 * DELETE — removes a scoped limit (fall back to the org limits alone).
 *
 * Thin handlers; gating, validation (422), and the audit trail live in
 * `@/lib/budgets/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { getBudgetOverview, removeBudgetPolicy, saveBudgetPolicy } from '@/lib/budgets/service'

const limitSchema = z.number().min(0).finite().nullable()

const putSchema = z.object({
  scope: z.enum(['organization', 'member', 'project']),
  subjectId: z.string().min(1).max(120).nullable().optional(),
  dailyLimitEur: limitSchema,
  monthlyLimitEur: limitSchema,
  note: z.string().trim().max(500).nullable().optional(),
})

const deleteSchema = z.object({
  scope: z.enum(['member', 'project']),
  subjectId: z.string().min(1).max(120),
})

export const GET = apiRoute(async ({ session }) => getBudgetOverview(session))

export const PUT = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, putSchema)
    return { policy: await saveBudgetPolicy(session, input, request) }
  },
  { status: 201 },
)

export const DELETE = apiRoute(async ({ session, request }) => {
  const input = await parseJsonBody(request, deleteSchema)
  return { removed: await removeBudgetPolicy(session, input, request) }
})
