/**
 * The worker's claim on a plan: may the run start, and with which plan?
 *
 * Acts as nobody, like the ledger route: the worker holds a plan id and the
 * service token, and the row says whose the plan is. "Not yet" comes back as
 * data with a retry hint — a waiting run is the normal case, not an error —
 * so the worker polls this until `started` is true, and gives up only on the
 * one refusal, a plan that was replaced.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { claimPlanStart } from '@/lib/plans/service'

type Params = { planId: string }

export const POST = internalApiRoute<Params>(
  'Plan Start',
  async ({ params }) => claimPlanStart(params.planId),
  {
    tenancy: {
      fromPayload:
        'the research_plans row named by params.planId — resolved under platform access, then entered as that plan’s organization. There is no body',
    },
  }
)
