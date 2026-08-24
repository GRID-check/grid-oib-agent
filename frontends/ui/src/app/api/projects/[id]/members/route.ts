/**
 * Project members API — list the roster and assign project-level roles.
 * Thin handlers; the WorkOS FGA logic lives in `@/lib/projects/members-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { listProjectMembers, setProjectMemberRole } from '@/lib/projects/members-service'

type Params = { id: string }

const addMemberSchema = z.object({
  organizationMembershipId: z.string().min(1),
  roleSlug: z.union([z.enum(['project-viewer', 'project-editor', 'project-admin']), z.literal('')]),
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
