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

    const requested = new URL(request.url).searchParams.getAll('scope')
    const scopes = requested
      .filter((s): s is OrgWidgetPermission => ALLOWED.has(s))
      .filter((s) => grants(session, s))

    const { token } = await getWorkOS().widgets.createToken({
      organizationId: session.organizationId,
      userId: session.userId,
      ...(scopes.length > 0 ? { scopes } : {}),
    })

    return NextResponse.json(
      { token },
      // The token is user-specific and short-lived — never cache it.
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
