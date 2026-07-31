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
import { BadRequestError } from '@/lib/api/errors'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { SHAREABLE_RESOURCE_TYPES, type ShareableResourceType } from '@/lib/db/schema'
import { listShareCandidates } from '@/lib/mentions/service'

type Params = { resourceType: string; resourceId: string }

/** See the note in `../route.ts` on why this guard is local to each route. */
function requireShareableType(raw: string): ShareableResourceType {
  const resourceType = SHAREABLE_RESOURCE_TYPES.find((candidate) => candidate === raw)
  if (!resourceType) {
    throw new BadRequestError(`"${raw}" is not a shareable resource type`, {
      allowed: SHAREABLE_RESOURCE_TYPES,
    })
  }
  return resourceType
}

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
