/**
 * Organization member directory (for admin pickers — e.g. per-member budget
 * limits). Org admins only; returns id + email + display name per active
 * member, straight from WorkOS (the identity source of truth, ADR-0007).
 */

import { apiRoute } from '@/lib/api/handler'
import { ForbiddenError } from '@/lib/api/errors'
import { isOrgAdmin } from '@/lib/authz/organizations'
import { listOrganizationMembers } from '@/lib/organizations/service'

export const GET = apiRoute(
  async ({ session }) => {
    // Broad org-admin gate (settings permission OR the users-table widget
    // permission) — richer than a single registry permission, so checked here.
    if (!isOrgAdmin(session)) {
      throw new ForbiddenError()
    }
    return { members: await listOrganizationMembers(session.organizationId) }
  },
  { authz: { enforcedBy: 'isOrgAdmin gate in the handler' } }
)
