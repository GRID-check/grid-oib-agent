/**
 * Server-side session helpers built on WorkOS AuthKit v4.
 */

import { getTokenClaims, withAuth } from '@workos-inc/authkit-nextjs'
import { getWorkOS } from '@/lib/workos/client'
import { getCached } from '@/lib/cache'
import type { GridSession } from './types'

/**
 * Membership ids change only when a user joins/leaves an org, but this lookup
 * sits on every authenticated request — without a cache it is a WorkOS network
 * round-trip per request. A missing membership is cached briefly so a signed-in
 * user without one doesn't hammer WorkOS either.
 */
const MEMBERSHIP_TTL_MS = 10 * 60_000
const MEMBERSHIP_NEGATIVE_TTL_MS = 30_000

/**
 * Resolve the WorkOS organization membership id for a user + organization.
 *
 * Returns `null` when no active membership is found.
 */
async function resolveOrganizationMembershipId(
  userId: string,
  organizationId: string
): Promise<string | null> {
  return getCached(
    `membership:${organizationId}:${userId}`,
    MEMBERSHIP_TTL_MS,
    async () => {
      const memberships = await getWorkOS().userManagement.listOrganizationMemberships({
        userId,
        organizationId,
        limit: 1,
      })
      return memberships.data[0]?.id ?? null
    },
    { negativeTtlMs: MEMBERSHIP_NEGATIVE_TTL_MS },
  )
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
    featureFlags: auth.featureFlags ?? null,
    profilePictureUrl: auth.user.profilePictureUrl ?? null,
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
