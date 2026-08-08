/**
 * Generic sharing API — read a resource's sharing state, change its visibility
 * (ADR-0032, spec SH-1…SH-20).
 *
 * The route is deliberately typed on `[resourceType]` rather than mounted under
 * `/api/conversations/…`: sharing is a substrate, not a chat feature, and the
 * second consumer must cost one registry entry and nothing here (spec SH-9).
 * Thin adapters (ADR-0017); all logic and authorization live in
 * `@/lib/sharing/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { RESOURCE_VISIBILITIES } from '@/lib/db/schema'
import { getSharingState, setResourceVisibility } from '@/lib/sharing/service'
import { requireShareableType } from '@/lib/sharing/registry'

type Params = { resourceType: string; resourceId: string }

const visibilitySchema = z.object({
  visibility: z.enum(RESOURCE_VISIBILITIES),
})

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    return getSharingState(session, requireShareableType(params.resourceType), params.resourceId)
  },
  { authz: { enforcedBy: 'getSharingState (requireResourceAccess)' } }
)

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const { visibility } = await parseJsonBody(request, visibilitySchema)
    return setResourceVisibility(
      session,
      requireShareableType(params.resourceType),
      params.resourceId,
      visibility,
      request
    )
  },
  { authz: { enforcedBy: 'setResourceVisibility (requireResourceAccess owner)' } }
)
