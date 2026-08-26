/**
 * WorkOS widget authorization token service.
 *
 * Mints a short-lived (≈1h) widget session token scoped to the signed-in user
 * and their active organization.
 *
 * - With no requested scopes it mints a scope-less token for the user-scoped
 *   widgets (User Sessions / User Security / User Profile), which act on the
 *   authenticated user themselves.
 * - With requested scopes it mints an org-management token — but only for the
 *   scopes the caller actually holds. `widgets:users-table:manage` is granted
 *   to org admins; every other org widget scope is granted only when present
 *   in the session's WorkOS permissions. Requested scopes the caller lacks
 *   are silently dropped, so a non-admin can never escalate here.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import {
  ORG_WIDGET_PERMISSIONS,
  USERS_TABLE_MANAGE,
  isOrgAdmin,
  type OrgWidgetPermission,
} from '@/lib/authz/organizations'
import {
  getPlatformOrganizationId,
  PlatformAccessDeniedError,
  requirePlatformPermission,
} from '@/lib/authz/platform'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { ForbiddenError, ServiceUnavailableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'

const ALLOWED = new Set<string>(ORG_WIDGET_PERMISSIONS)

/** True when the session is permitted to hold `scope`. */
function grants(session: AuthorizedSession, scope: OrgWidgetPermission): boolean {
  if (scope === USERS_TABLE_MANAGE) return isOrgAdmin(session)
  return session.permissions.includes(scope)
}

/**
 * Mint a widget token for the caller. `forPlatformOrg` mints the token
 * against the GRID Platform organization (the platform owner's dashboard
 * widgets). Platform owners hold the platform-org membership WorkOS
 * requires; the guard rejects everyone else before any token is created
 * (ADR-0016).
 */
export async function mintWidgetToken(
  session: AuthorizedSession,
  requestedScopes: string[],
  forPlatformOrg: boolean
): Promise<{ token: string }> {
  let organizationId = session.organizationId
  let holdsScope = (scope: OrgWidgetPermission): boolean => grants(session, scope)
  if (forPlatformOrg) {
    try {
      // Minting a platform-org widget token hands the holder WorkOS's own user,
      // SSO and directory admin surfaces. That is administration, not oversight,
      // so read-only platform staff must not reach it.
      await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsManage)
    } catch (error) {
      if (error instanceof PlatformAccessDeniedError) throw new ForbiddenError()
      throw error
    }
    const platformOrgId = await getPlatformOrganizationId()
    if (!platformOrgId) {
      throw new ServiceUnavailableError('Platform organization is not provisioned')
    }
    organizationId = platformOrgId
    // The platform dashboard only embeds the users-table widget; keep the
    // grant that narrow instead of blanket-passing every allowed scope.
    holdsScope = (scope) => scope === USERS_TABLE_MANAGE
  }

  const scopes = requestedScopes
    .filter((s): s is OrgWidgetPermission => ALLOWED.has(s))
    .filter(holdsScope)

  const { token } = await getWorkOS().widgets.createToken({
    organizationId,
    userId: session.userId,
    ...(scopes.length > 0 ? { scopes } : {}),
  })

  return { token }
}
