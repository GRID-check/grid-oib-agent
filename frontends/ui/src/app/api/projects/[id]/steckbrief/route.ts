/**
 * The Steckbrief of a project (ADR-0090): read it, or set its period. Thin
 * handlers; who may, and the audit trail, live in `steckbrief-service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { getSteckbrief, setProjectPeriod } from '@/lib/projects/steckbrief-service'
import { projectPeriodSchema } from '@/lib/projects/steckbrief-types'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getSteckbrief(session, params.id), {
  authz: { enforcedBy: 'getSteckbrief (requireProjectAccess project:view)' },
})

export const PUT = apiRoute<Params>(
  async ({ session, params, request }) => {
    const period = await parseJsonBody(request, projectPeriodSchema)
    return setProjectPeriod(session, params.id, period, request)
  },
  { authz: { enforcedBy: 'setProjectPeriod (requireProjectAccess project:memory:write | project:edit)' } }
)
