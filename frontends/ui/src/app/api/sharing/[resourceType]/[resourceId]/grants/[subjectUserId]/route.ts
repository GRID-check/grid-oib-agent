/**
 * Revoke one person's grant (spec SH-12, SH-13).
 *
 * The same endpoint serves "remove Anna" and "leave this chat": the service
 * distinguishes them by whether the subject is the caller, because leaving needs
 * no ownership while removing someone else does. Thin adapter (ADR-0017).
 */

import { apiRoute } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { revokeResourceAccess } from '@/lib/sharing/service'
import { requireShareableType } from '@/lib/sharing/registry'

type Params = { resourceType: string; resourceId: string; subjectUserId: string }


export const DELETE = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    return revokeResourceAccess(
      session,
      requireShareableType(params.resourceType),
      params.resourceId,
      params.subjectUserId,
      request
    )
  },
  { authz: { enforcedBy: 'revokeResourceAccess (requireResourceAccess owner)' } }
)
