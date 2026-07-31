/**
 * Project member assignment removal API — remove a WorkOS FGA role
 * assignment from a project. Thin handler; logic lives in
 * `@/lib/projects/members-service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { removeProjectRoleAssignment } from '@/lib/projects/members-service'

export const DELETE = apiRoute<{ id: string; assignmentId: string }>(
  async ({ session, params, request }) => {
    await removeProjectRoleAssignment(session, params.id, params.assignmentId, request)
  },
  {
    authz: {
      enforcedBy: 'removeProjectRoleAssignment (requireProjectAccess project:members:manage)',
    },
  }
)
