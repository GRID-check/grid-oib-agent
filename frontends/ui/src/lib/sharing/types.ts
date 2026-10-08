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
  /**
   * True when the person is still a party to the resource but can no longer
   * read what it was drawn from (a folder's access narrowed, a role taken
   * away; ADR-0085). The roster says so; it never says which folder. Absent
   * for a resource whose content is judged by the role alone.
   */
  lostAccess?: boolean
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
  /**
   * Cannot read every folder this conversation drew on, so cannot be let in
   * (ADR-0085). Rendered disabled with a reason that never names the folder;
   * the server's refusal on the grant stays the authority. Absent for a
   * resource whose content is judged by the role alone.
   */
  lacksFolderAccess?: boolean
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
  /** Share-mutation rate limit hit (spec SH-16) — the remedy is to wait. */
  rateLimited: 'rate-limited',
  /** The roster is at SHARE_ROSTER_LIMIT; someone must leave before anyone joins. */
  rosterFull: 'roster-full',
  /**
   * The person being let in is not cleared for every restricted folder the
   * conversation drew on (ADR-0086). `details.person` names them; `details.folders`
   * names the folders, and only to a sharer cleared for them.
   */
  restrictedContent: 'restricted-content',
  /** As {@link restrictedContent}, for a project admin escalating to owner: the person is the caller. */
  restrictedContentSelf: 'restricted-content-self',
  /**
   * The conversation drew on a restricted folder, so it cannot be made visible to
   * the whole project: its readers there cannot be enumerated. It can still be
   * shared with each cleared person.
   */
  restrictedContentProject: 'restricted-content-project',
} as const
