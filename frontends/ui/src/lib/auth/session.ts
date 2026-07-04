/**
 * Server-side session helpers built on WorkOS AuthKit v4.
 */

import { getTokenClaims, withAuth } from '@workos-inc/authkit-nextjs'
import { getWorkOS } from '@/lib/workos/client'
import type { GridSession } from './types'

/**
 * Resolve the WorkOS organization membership id for a user + organization.
 *
 * Returns `null` when no active membership is found.
 */
async function resolveOrganizationMembershipId(
  userId: string,
  organizationId: string
): Promise<string | null> {
  const workos = getWorkOS()

  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId,
    organizationId,
    limit: 1,
  })

  return memberships.data[0]?.id ?? null
}

/**
 * Read the current Grid session from the WorkOS AuthKit session cookie.
 *
 * Uses `withAuth()` (and `getTokenClaims()` for raw JWT claims) from AuthKit v4.
 * Returns `null` when the user is not signed in.
 */
export async function getGridSession(): Promise<GridSession | null> {
  const auth = await withAuth()

  if (!auth.user || !auth.accessToken) {
    return null
  }

  // Raw claims are available from the access token if we need to resolve
  // additional custom claims beyond what withAuth() already surfaces.
  const claims = await getTokenClaims(auth.accessToken)

  const name =
    auth.user.firstName && auth.user.lastName
      ? `${auth.user.firstName} ${auth.user.lastName}`
      : auth.user.firstName || auth.user.lastName || auth.user.name || null

  const organizationId = auth.organizationId ?? null

  const organizationMembershipId = organizationId
    ? await resolveOrganizationMembershipId(auth.user.id, organizationId)
    : null

  return {
    userId: auth.user.id,
    email: auth.user.email,
    name,
    accessToken: auth.accessToken,
    organizationId,
    organizationMembershipId,
    role: auth.role ?? (typeof claims.role === 'string' ? claims.role : null),
    permissions: auth.permissions ?? [],
  }
}

/**
 * Require a signed-in Grid session.
 *
 * @throws {Error} when no WorkOS session is present.
 */
export async function requireGridSession(): Promise<GridSession> {
  const session = await getGridSession()

  if (!session) {
    throw new Error('Unauthorized: Grid session required')
  }

  return session
}
