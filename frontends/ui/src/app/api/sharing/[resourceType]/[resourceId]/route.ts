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
import { BadRequestError } from '@/lib/api/errors'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { RESOURCE_VISIBILITIES, SHAREABLE_RESOURCE_TYPES, type ShareableResourceType } from '@/lib/db/schema'
import { getSharingState, setResourceVisibility } from '@/lib/sharing/service'

type Params = { resourceType: string; resourceId: string }

const visibilitySchema = z.object({
  visibility: z.enum(RESOURCE_VISIBILITIES),
})

/**
 * Validate the path's resource type against the registry's union.
 *
 * A 400 rather than a 404: an unregistered type is a malformed request, not a
 * resource the caller may not see, and telling them so is not a disclosure —
 * the set of shareable types is public API surface.
 *
 * Deliberately duplicated across the four sharing routes: Next.js route modules
 * may only export HTTP handlers, so a shared local helper would need a module of
 * its own for five lines.
 */
function requireShareableType(raw: string): ShareableResourceType {
  const resourceType = SHAREABLE_RESOURCE_TYPES.find((candidate) => candidate === raw)
  if (!resourceType) {
    throw new BadRequestError(`"${raw}" is not a shareable resource type`, {
      allowed: SHAREABLE_RESOURCE_TYPES,
    })
  }
  return resourceType
}

export const GET = apiRoute<Params>(async ({ session, params }) => {
  const gated = requireCollaborationEnabled(session)
  if (gated) return gated
  return getSharingState(session, requireShareableType(params.resourceType), params.resourceId)
})

export const PATCH = apiRoute<Params>(async ({ session, params, request }) => {
  const gated = requireCollaborationEnabled(session)
  if (gated) return gated
  const { visibility } = await parseJsonBody(request, visibilitySchema)
  return setResourceVisibility(
    session,
    requireShareableType(params.resourceType),
    params.resourceId,
    visibility,
    request,
  )
})
