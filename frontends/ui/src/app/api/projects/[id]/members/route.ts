/**
 * Project members API — list the roster and assign project-level roles.
 * Thin handlers; the WorkOS FGA logic lives in `@/lib/projects/members-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { listProjectMembers, setProjectMemberRole } from '@/lib/projects/members-service'

type Params = { id: string }

/**
 * The assignable project roles, mirroring `ROLES` in `lib/authz/catalog.ts`.
 * `project-contributor` was missing here, which is what made a catalog role
 * unreachable from the product: the API refused the slug, so the form could not
 * offer it and the roster could only ever show the other three.
 */
const addMemberSchema = z.object({
  organizationMembershipId: z.string().min(1),
  roleSlug: z.union([
    z.enum(['project-viewer', 'project-contributor', 'project-editor', 'project-admin']),
    z.literal(''),
  ]),
})

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({
    members: await listProjectMembers(session, params.id),
  }),
  { authz: { enforcedBy: 'listProjectMembers (requireProjectAccess project:members:manage)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, addMemberSchema)
    await setProjectMemberRole(session, params.id, input, request)
  },
  {
    status: 201,
    authz: { enforcedBy: 'setProjectMemberRole (requireProjectAccess project:members:manage)' },
  }
)
