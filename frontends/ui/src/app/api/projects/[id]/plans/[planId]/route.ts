/**
 * One plan: read it, or change it while the run still waits on it. Thin
 * adapters over the plans service; the ids in the path reach it unchanged.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { researchPlanEditSchema } from '@/lib/plans/plan-types'
import { editPlan, getPlan } from '@/lib/plans/service'

type Params = { id: string; planId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getPlan(session, params.id, params.planId),
  { authz: { enforcedBy: 'getPlan (requireProjectAccess project:view)' } }
)

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const edit = await parseJsonBody(request, researchPlanEditSchema)
    return editPlan(session, params.id, params.planId, edit)
  },
  { authz: { enforcedBy: 'editPlan (requireProjectAccess project:view + CHAT_PERMISSIONS)' } }
)
