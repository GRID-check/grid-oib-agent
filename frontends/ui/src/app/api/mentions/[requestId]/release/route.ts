/**
 * Release a wait — "ohne Anna weitermachen" (spec MN-9.2).
 *
 * Deliberately available to ANY contributor on the resource, not just the asker
 * and not just an owner: an abandoned wait is the failure mode ADR-0034 names,
 * and the mitigation is that getting out of it is always one click away for
 * whoever is in the room.
 *
 * Mounted on the request id rather than under the conversation, because a request
 * is a first-class object of the substrate and the second mention surface (a
 * document comment) must release through this same endpoint (spec MN-19).
 *
 * Thin adapter (ADR-0017); logic in `@/lib/mentions/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { releaseRequest } from '@/lib/mentions/service'

type Params = { requestId: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    return releaseRequest(session, params.requestId)
  },
  { authz: { enforcedBy: 'releaseRequest (requireResourceAccess)' } }
)
