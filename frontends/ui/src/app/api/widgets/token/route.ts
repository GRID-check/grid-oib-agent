/**
 * WorkOS widget authorization token.
 *
 * Mints a short-lived (≈1h) widget session token scoped to the signed-in user
 * and their active organization.
 *
 * - With no `?scope=` params it mints a scope-less token for the user-scoped
 *   widgets (User Sessions / User Security / User Profile), which act on the
 *   authenticated user themselves.
 * - With `?scope=` params (repeatable) it mints an org-management token — but
 *   only for the scopes the caller actually holds. `widgets:users-table:manage`
 *   is granted to org admins; every other org widget scope is granted only when
 *   present in the session's WorkOS permissions. Requested scopes the caller
 *   lacks are silently dropped, so a non-admin can never escalate here.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getWorkOS } from '@/lib/workos/client'
import {
  ORG_WIDGET_PERMISSIONS,
  USERS_TABLE_MANAGE,
  isOrgAdmin,
  type OrgWidgetPermission,
} from '@/lib/authz/organizations'
import { getPlatformOrganizationId, PlatformAccessDeniedError, requirePlatformOwner } from '@/lib/authz/platform'
import type { AuthorizedSession } from '@/lib/auth/types'

const ALLOWED = new Set<string>(ORG_WIDGET_PERMISSIONS)

/** True when the session is permitted to hold `scope`. */
function grants(session: AuthorizedSession, scope: OrgWidgetPermission): boolean {
  if (scope === USERS_TABLE_MANAGE) return isOrgAdmin(session)
  return session.permissions.includes(scope)
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const url = new URL(request.url)

    // `?org=platform` mints the token against the GRID Platform organization
    // (the platform owner's dashboard widgets). Platform owners hold the
    // platform-org membership WorkOS requires; the guard rejects everyone
    // else before any token is created (ADR-0016).
    let organizationId = session.organizationId
    let holdsScope = (scope: OrgWidgetPermission): boolean => grants(session, scope)
    if (url.searchParams.get('org') === 'platform') {
      await requirePlatformOwner(session)
      const platformOrgId = await getPlatformOrganizationId()
      if (!platformOrgId) {
        return NextResponse.json({ error: 'Platform organization is not provisioned' }, { status: 503 })
      }
      organizationId = platformOrgId
      // The platform dashboard only embeds the users-table widget; keep the
      // grant that narrow instead of blanket-passing every allowed scope.
      holdsScope = (scope) => scope === USERS_TABLE_MANAGE
    }

    const requested = url.searchParams.getAll('scope')
    const scopes = requested.filter((s): s is OrgWidgetPermission => ALLOWED.has(s)).filter(holdsScope)

    const { token } = await getWorkOS().widgets.createToken({
      organizationId,
      userId: session.userId,
      ...(scopes.length > 0 ? { scopes } : {}),
    })

    return NextResponse.json(
      { token },
      // The token is user-specific and short-lived — never cache it.
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
