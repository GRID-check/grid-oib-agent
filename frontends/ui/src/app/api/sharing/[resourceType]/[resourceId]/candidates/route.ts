/**
 * Invite candidates for the share dialog (spec SH-19).
 *
 * Returns `ShareCandidate[]`: organization members who may be invited, plus the
 * ones who may NOT yet — flagged `needsProjectAccess` rather than hidden, so the
 * dialog can explain the block and offer to add them to the project first instead
 * of silently pretending they do not exist.
 *
 * Thin adapter (ADR-0017); the roster is computed in `@/lib/mentions/service`,
 * which owns the identical computation behind the `@` picker.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { listShareCandidates } from '@/lib/mentions/service'
import { requireShareableType } from '@/lib/sharing/registry'

type Params = { resourceType: string; resourceId: string }


export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    return listShareCandidates(
      session,
      requireShareableType(params.resourceType),
      params.resourceId
    )
  },
  { authz: { enforcedBy: 'listShareCandidates (requireResourceAccess)' } }
)
