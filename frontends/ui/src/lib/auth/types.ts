/**
 * Grid session types produced from the WorkOS AuthKit v4 session.
 *
 * All server-side code should consume these types instead of the raw
 * `@workos-inc/authkit-nextjs` types.
 */

export interface GridSession {
  /** WorkOS user id (JWT `sub` claim) */
  userId: string

  /** User email address */
  email: string

  /** Full display name, or null when not available */
  name: string | null

  /** Raw WorkOS access token to forward to the AI-Q backend */
  accessToken: string

  /** Active WorkOS organization id, or null when none is selected */
  organizationId: string | null

  /** Active WorkOS organization membership id, or null when not resolved */
  organizationMembershipId: string | null

  /** WorkOS role slug within the active organization, or null */
  role: string | null

  /** WorkOS permissions within the active organization */
  permissions: string[]

  /**
   * WorkOS feature flags enabled for this user+org context (JWT
   * `feature_flags` claim). `null` when the token carries no claim —
   * distinguishable from "no flags enabled" for fail-closed enforcement.
   */
  featureFlags: string[] | null

  /** WorkOS profile picture URL, or null when none is set. */
  profilePictureUrl?: string | null
}

/**
 * Grid session that is guaranteed to have an active WorkOS organization.
 *
 * Use this type for routes and API handlers that require tenant-scoped
 * authorization.
 */
export interface AuthorizedSession extends GridSession {
  organizationId: string
  organizationMembershipId: string
  role: string
  permissions: string[]
}
