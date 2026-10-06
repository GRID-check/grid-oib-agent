/**
 * The folders that name one custom role (ADR-0081): what the deletion
 * confirmation shows before a role is removed.
 *
 * GET — `org:members:manage`. `total` is the number of living folders of
 *       living projects whose own access list names the role. `folders` names
 *       them, with their projects, only for someone who also holds
 *       `org:projects:administer` and so may read those folders; a role
 *       manager without it is given the count and no names.
 */

import { apiRoute } from '@/lib/api/handler'
import { getCustomRoleUsage } from '@/lib/authz/custom-roles'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'

type Params = { slug: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getCustomRoleUsage(session, params.slug), {
  authz: { permission: ORG_PERMISSIONS.membersManage },
})
