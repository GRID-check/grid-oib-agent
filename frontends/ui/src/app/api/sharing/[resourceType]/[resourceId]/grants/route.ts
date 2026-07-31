/**
 * Grants API — invite a person, change their role, or (for a project admin) take
 * ownership of a resource they were not party to (spec SH-3, SH-10, SH-11).
 *
 * POST creates access, PATCH changes an existing role: two verbs because the
 * invariants differ — creating is bounded by the roster cap and the container
 * precondition, changing is bounded by the last-owner rule. Thin adapters
 * (ADR-0017); every check lives in `@/lib/sharing/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import {
  RESOURCE_ROLES,
  SHAREABLE_RESOURCE_TYPES,
  type ShareableResourceType,
} from '@/lib/db/schema'
import { changeResourceRole, escalateToOwner, grantResourceAccess } from '@/lib/sharing/service'

type Params = { resourceType: string; resourceId: string }

/**
 * `collaborator` is the default role for an invitee (spec SH-10) — the role that
 * lets someone actually take part, which is the point of inviting them.
 */
const grantSchema = z.object({
  subjectUserId: z.string().min(1).max(256),
  role: z.enum(RESOURCE_ROLES).default('collaborator'),
})

/**
 * Self-escalation is a distinct, audited act rather than "grant yourself owner",
 * so it is its own body shape: a project admin taking ownership must be
 * distinguishable from a normal grant in the audit trail (spec SH-10, SH-14).
 */
const escalateSchema = z.object({ escalate: z.literal(true) })

const postSchema = z.union([escalateSchema, grantSchema])

const roleChangeSchema = z.object({
  subjectUserId: z.string().min(1).max(256),
  role: z.enum(RESOURCE_ROLES),
})

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

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const resourceType = requireShareableType(params.resourceType)
    const body = await parseJsonBody(request, postSchema)

    if ('escalate' in body) {
      return escalateToOwner(session, resourceType, params.resourceId, request)
    }
    return grantResourceAccess(session, resourceType, params.resourceId, body, request)
  },
  { status: 201, authz: { enforcedBy: 'grantResourceAccess (requireResourceAccess owner)' } }
)

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireCollaborationEnabled(session)
    if (gated) return gated
    const body = await parseJsonBody(request, roleChangeSchema)
    return changeResourceRole(
      session,
      requireShareableType(params.resourceType),
      params.resourceId,
      body,
      request
    )
  },
  { authz: { enforcedBy: 'changeResourceRole (requireResourceAccess owner)' } }
)
