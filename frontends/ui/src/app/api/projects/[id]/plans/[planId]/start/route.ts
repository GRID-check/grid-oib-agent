/** „Starten": approve the plan; the worker starts the run at its next claim. */

import { apiRoute } from '@/lib/api/handler'
import { startPlan } from '@/lib/plans/service'

type Params = { id: string; planId: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => startPlan(session, params.id, params.planId),
  { authz: { enforcedBy: 'startPlan (requireProjectAccess project:view + COMMISSION_PERMISSIONS)' } }
)
