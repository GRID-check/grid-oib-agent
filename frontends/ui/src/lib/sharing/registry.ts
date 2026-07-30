/**
 * The shareable-resource registry — the extension point that makes sharing a
 * platform capability rather than a chat feature (ADR-0032, spec SH-7…SH-9).
 *
 * Adding a shareable resource type should cost ONE entry here plus two
 * translations. Nothing in `@/lib/sharing/access`, `@/lib/sharing/service`, the
 * share dialog, the access chip, or the inbox knows what a conversation is —
 * they all work through these descriptors.
 *
 * The map is **exhaustive by construction**: it is typed as
 * `Record<ShareableResourceType, ShareableDescriptor>`, so adding a member to
 * `SHAREABLE_RESOURCE_TYPES` without registering it here fails `tsc`. Same
 * discipline as `CARD_INTERACTIVITY` for card types.
 *
 * Layering note: descriptors may reach into a domain's REPOSITORY (data access)
 * but never its SERVICE (which authorizes, and would authorize through this
 * module — a cycle). That keeps the dependency arrow one-way:
 * service → access → registry → repository.
 */

import 'server-only'
import {
  RESOURCE_ROLES,
  type ResourceRole,
  type ResourceVisibility,
  type ShareableResourceType,
} from '@/lib/db/schema'
import { findConversationTenancy } from '@/lib/conversations/repository'

/**
 * Everything `@/lib/sharing/access` needs about a resource to decide access, in
 * ONE probe.
 *
 * Deliberately a single call rather than separate container/visibility/creator
 * lookups: access resolution is the hottest read in the feature (every message
 * fetch goes through it), and three probes would mean three identical queries
 * per check.
 *
 * `projectId: null` means the resource hangs directly off the organization —
 * legitimate for legacy conversations created before project stamping, which no
 * project membership could describe.
 */
export interface ResourceProbe {
  organizationId: string
  projectId: string | null
  visibility: ResourceVisibility
  /** WorkOS user id of the creator, who is always an owner. */
  createdBy: string | null
  /** Set when soft-deleted; callers decide whether that is a 404. */
  deletedAt: Date | null
}

export interface ShareableDescriptor {
  /** Stable key — appears in grants, inbox items, audit events and deep links. */
  readonly type: ShareableResourceType
  /**
   * Resolve tenancy, container, visibility and creator WITHOUT authorizing.
   * Returns null when the resource does not exist (callers turn that into a 404).
   *
   * Deliberately unauthorized: the caller (`resolveResourceAccess`) decides
   * whether an organization mismatch is a 404, exactly as `findProjectTenancy`
   * does for projects.
   */
  readonly probe: (resourceId: string) => Promise<ResourceProbe | null>
  /** Visibility modes this type permits, weakest first. */
  readonly allowedVisibilities: readonly ResourceVisibility[]
  /** Visibility a newly created resource of this type gets. */
  readonly defaultVisibility: ResourceVisibility
  /** Roles this type supports, weakest first. */
  readonly roles: readonly ResourceRole[]
  /** Whether mentions can be written inside this resource (spec MN-19). */
  readonly supportsMentions: boolean
  /**
   * Deep link to the resource, optionally to an exact spot inside it. Used by
   * the share surface AND by every inbox item that points at this type, so a
   * notification can always land the user where the thing happened.
   */
  readonly deepLink: (resourceId: string, options?: { anchorId?: string; projectId?: string | null }) => string
  /** i18n key suffix for the type's display name (`sharing.resourceTypes.<key>`). */
  readonly labelKey: string
}

/**
 * Organization-wide chat visibility is deliberately withheld in phase 1: the
 * model carries the value (so no migration is needed later) but offering it
 * before the org-policy control exists would let one member expose a thread to
 * everyone with no way for an admin to prevent it (spec SH-15, phase 2).
 */
const CONVERSATION_VISIBILITIES = ['private', 'project'] as const

/**
 * Conversations — the first consumer. Everything here is data, not behaviour:
 * that is the test of whether the substrate is real.
 */
const conversationDescriptor: ShareableDescriptor = {
  type: 'conversation',
  probe: async (resourceId) => {
    const row = await findConversationTenancy(resourceId)
    if (!row) return null
    return {
      organizationId: row.organizationId,
      projectId: row.projectId,
      visibility: row.visibility,
      createdBy: row.createdBy,
      deletedAt: row.deletedAt,
    }
  },
  allowedVisibilities: CONVERSATION_VISIBILITIES,
  defaultVisibility: 'private',
  roles: RESOURCE_ROLES,
  supportsMentions: true,
  deepLink: (resourceId, options) => {
    const anchor = options?.anchorId ? `#message-${encodeURIComponent(options.anchorId)}` : ''
    // A conversation is always reached through its project's chat surface when
    // we know the project; otherwise the chat route resolves it from history.
    return options?.projectId
      ? `/app/projects/${encodeURIComponent(options.projectId)}/chat?conversation=${encodeURIComponent(resourceId)}${anchor}`
      : `/app/chat?conversation=${encodeURIComponent(resourceId)}${anchor}`
  },
  labelKey: 'conversation',
}

export const SHAREABLE_REGISTRY: Record<ShareableResourceType, ShareableDescriptor> = {
  conversation: conversationDescriptor,
}

/** Descriptor lookup. Throws on an unregistered type — that is a programming error. */
export function describeResource(type: ShareableResourceType): ShareableDescriptor {
  const descriptor = SHAREABLE_REGISTRY[type]
  if (!descriptor) {
    throw new Error(`[sharing] No registry entry for resource type "${type}"`)
  }
  return descriptor
}

/** Rank of a role on the ladder; higher wins. */
export function roleRank(role: ResourceRole): number {
  return RESOURCE_ROLES.indexOf(role)
}

/** The stronger of two roles — the core of "effective access" (spec SH-4). */
export function strongerRole(a: ResourceRole | null, b: ResourceRole | null): ResourceRole | null {
  if (!a) return b
  if (!b) return a
  return roleRank(a) >= roleRank(b) ? a : b
}

/** Whether `role` satisfies a minimum requirement. */
export function roleSatisfies(role: ResourceRole | null, minimum: ResourceRole): boolean {
  return role !== null && roleRank(role) >= roleRank(minimum)
}
