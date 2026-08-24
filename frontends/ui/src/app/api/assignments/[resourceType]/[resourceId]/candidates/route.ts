/**
 * People a collaborator may assign — project members, not org-admin-only.
 * Distinct from share invite candidates (owner). Assignment is not access.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { listAssignmentCandidates } from '@/lib/assignments/service'
import { requireShareableType } from '@/lib/sharing/registry'

type Params = { resourceType: string; resourceId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const candidates = await listAssignmentCandidates(
      session,
      requireShareableType(params.resourceType),
      params.resourceId,
    )
    return { candidates }
  },
  { authz: { enforcedBy: 'listAssignmentCandidates (requireResourceAccess collaborator)' } },
)
