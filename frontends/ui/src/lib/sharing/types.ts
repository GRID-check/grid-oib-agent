/**
 * Sharing wire types — the contract between the BFF and the browser.
 *
 * Deliberately in its own module with NO `'server-only'` marker and no imports
 * from server modules, so client components can import these shapes. The service
 * (`./service`) is server-only and re-exports nothing the client needs to reach
 * through it.
 */

import type { ResourceRole, ResourceVisibility, ShareableResourceType } from '@/lib/db/schema'

export type { ResourceRole, ResourceVisibility, ShareableResourceType }

/** Why someone has access — shown in the roster so access is never mysterious. */
export type AccessReason = 'creator' | 'grant' | 'visibility-project' | 'visibility-organization'

/** A person as the collaboration surfaces render them. */
export interface DirectoryPerson {
  userId: string
  email: string | null
  name: string
  profilePictureUrl: string | null
}

/** One row of the "who has access" list. */
export interface ResourceAccessEntry {
  person: DirectoryPerson
  role: ResourceRole
  reason: AccessReason
  grantedBy: string | null
}

/** `GET /api/sharing/:resourceType/:resourceId` */
export interface ResourceSharingState {
  resourceType: ShareableResourceType
  resourceId: string
  visibility: ResourceVisibility
  /** Visibilities this resource type permits — drives the UI's options. */
  allowedVisibilities: readonly ResourceVisibility[]
  myRole: ResourceRole | null
  canManage: boolean
  /** Project admin who may take ownership of a resource they were not party to. */
  canEscalate: boolean
  entries: ResourceAccessEntry[]
  /** True when the server is authoritative for this resource (ADR-0033). */
  shared: boolean
}

/** A person who may be invited or mentioned, with why they might not be. */
export interface ShareCandidate {
  person: DirectoryPerson
  /** Already has access — offer a role change, not an invitation. */
  alreadyHasAccess: boolean
  /**
   * In the organization but NOT in the container project, so they cannot be
   * invited until someone adds them to the project (spec SH-5, SH-19). Rendered
   * disabled with the reason rather than hidden, so the block is explicable.
   */
  needsProjectAccess: boolean
}

/** Machine-readable refusal reasons, so the UI can localise without parsing prose. */
export const SHARING_ERROR_REASONS = {
  containerAccessRequired: 'container-access-required',
  /**
   * The subject is not a member of the caller's organization. Distinct from
   * `containerAccessRequired` because the remedy is different: nobody can add them
   * to a project they are not in the tenant of.
   */
  organizationMembershipRequired: 'organization-membership-required',
  lastOwner: 'last-owner',
} as const
