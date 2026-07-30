/**
 * Revoke one person's grant (spec SH-12, SH-13).
 *
 * The same endpoint serves "remove Anna" and "leave this chat": the service
 * distinguishes them by whether the subject is the caller, because leaving needs
 * no ownership while removing someone else does. Thin adapter (ADR-0017).
 */

import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { SHAREABLE_RESOURCE_TYPES, type ShareableResourceType } from '@/lib/db/schema'
import { revokeResourceAccess } from '@/lib/sharing/service'

type Params = { resourceType: string; resourceId: string; subjectUserId: string }

/** See the note in `../../route.ts` on why this guard is local to each route. */
function requireShareableType(raw: string): ShareableResourceType {
  const resourceType = SHAREABLE_RESOURCE_TYPES.find((candidate) => candidate === raw)
  if (!resourceType) {
    throw new BadRequestError(`"${raw}" is not a shareable resource type`, {
      allowed: SHAREABLE_RESOURCE_TYPES,
    })
  }
  return resourceType
}

export const DELETE = apiRoute<Params>(async ({ session, params, request }) => {
  const gated = requireCollaborationEnabled(session)
  if (gated) return gated
  return revokeResourceAccess(
    session,
    requireShareableType(params.resourceType),
    params.resourceId,
    params.subjectUserId,
    request,
  )
})
