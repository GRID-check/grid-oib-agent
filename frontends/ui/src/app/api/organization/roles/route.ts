/**
 * The organization's roles, and the office's own custom roles (ADR-0084).
 *
 * GET  — any member: a project admin restricting a folder picks roles by name,
 *        and a lock on a folder names the roles it is restricted to, so every
 *        member needs the names. Permissions, and `assignable` (what the role
 *        editor may offer), are only in the answer for `org:members:manage`.
 * POST — `org:members:manage`, and only permissions the editor holds
 *        (`createCustomRole`). The slug is derived from the name, once.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import {
  assignableRolePermissions,
  createCustomRole,
  listOrganizationRoles,
} from '@/lib/authz/custom-roles'
import { roleFieldsSchema } from './schema'

export const GET = apiRoute(
  async ({ session }) => ({
    roles: await listOrganizationRoles(session),
    assignable: assignableRolePermissions(session),
  }),
  {
    authz: {
      sessionOnly: true,
      why: "role names are what a folder restriction and its lock show to every member of the organization; keyed by session.organizationId, permissions are withheld from non-managers by listOrganizationRoles, and every write requires org:members:manage",
    },
  }
)

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, roleFieldsSchema.strict())
    return { role: await createCustomRole(session, input, request) }
  },
  { status: 201, authz: { permission: ORG_PERMISSIONS.membersManage } }
)
