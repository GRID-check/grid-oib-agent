/** „Anpassen": stop the clock on a proposed plan. Idempotent. */

import { apiRoute } from '@/lib/api/handler'
import { holdPlan } from '@/lib/plans/service'

type Params = { id: string; planId: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => holdPlan(session, params.id, params.planId),
  { authz: { enforcedBy: 'holdPlan (requireProjectAccess project:view + CHAT_PERMISSIONS)' } }
)
