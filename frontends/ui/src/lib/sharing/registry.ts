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
import { BadRequestError } from '@/lib/api/errors'
import {
  RESOURCE_ROLES,
  SHAREABLE_RESOURCE_TYPES,
  type ResourceRole,
  type ResourceVisibility,
  type ShareableResourceType,
} from '@/lib/db/schema'
import {
  conversationIdsExisting,
  findConversationInOrg,
  findConversationTenancy,
  listConversationIdsForProject,
  updateConversationVisibilityInOrg,
} from '@/lib/conversations/repository'
import {
  documentIdsExisting,
  findDocumentTenancy,
  listDocumentIdsForProject,
  updateDocumentVisibilityInOrg,
} from '@/lib/documents/repository'
import { documentDisplayName } from '@/lib/documents/display-name'

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
export interface ResourceContainer {
  kind: 'project' | 'organization'
  id: string | null
}

export interface ResourceRef {
  title: string | null
}

export interface ResourceProbe {
  organizationId: string
  projectId: string | null
  /** Declared container — project documents use `project`; Archiv can declare `organization`. */
  container: ResourceContainer
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
  /**
   * Persist a visibility change. Returns false when the row is missing in this
   * org (caller maps to 404). Lives on the descriptor so a new type cannot
   * compile a silent no-op write (§3.1).
   */
  readonly setVisibility: (
    resourceId: string,
    organizationId: string,
    visibility: ResourceVisibility,
  ) => Promise<boolean>
  /** One-line title for inbox / mention copy (§3.3). */
  readonly describeRef: (resourceId: string, organizationId: string) => Promise<ResourceRef | null>
  /** Which of these ids still exist — orphan sweeps walk every registered type (§3.6). */
  readonly exists: (ids: readonly string[]) => Promise<Set<string>>
  /** Ids of this type inside a project — project-member cleanup (§3.5). */
  readonly listIdsInProject: (projectId: string, organizationId: string) => Promise<string[]>
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
      container: row.projectId
        ? { kind: 'project', id: row.projectId }
        : { kind: 'organization', id: row.organizationId },
      visibility: row.visibility,
      createdBy: row.createdBy,
      deletedAt: row.deletedAt,
    }
  },
  allowedVisibilities: CONVERSATION_VISIBILITIES,
  defaultVisibility: 'private',
  roles: RESOURCE_ROLES,
  supportsMentions: true,
  setVisibility: async (resourceId, organizationId, visibility) => {
    const row = await updateConversationVisibilityInOrg(resourceId, organizationId, visibility)
    return row !== null
  },
  describeRef: async (resourceId, organizationId) => {
    const row = await findConversationInOrg(resourceId, organizationId)
    if (!row) return null
    return { title: row.title ?? null }
  },
  exists: (ids) => conversationIdsExisting(ids),
  listIdsInProject: (projectId, organizationId) => listConversationIdsForProject(projectId, organizationId),
  deepLink: (resourceId, options) => {
    const anchor = options?.anchorId ? `#message-${encodeURIComponent(options.anchorId)}` : ''
    // `?session=` — the parameter the chat surface ALREADY reads (`useSessionUrl`).
    // This used to invent `?conversation=`, which nothing anywhere parsed, so every
    // inbox notification landed the recipient on whatever session happened to be
    // active while marking the row read. If this name ever changes, it changes in
    // `useSessionUrl` and here together.
    //
    // A conversation is always reached through its project's chat surface when
    // we know the project; otherwise the chat route resolves it from history.
    return options?.projectId
      ? `/app/projects/${encodeURIComponent(options.projectId)}/chat?session=${encodeURIComponent(resourceId)}${anchor}`
      : `/app/chat?session=${encodeURIComponent(resourceId)}${anchor}`
  },
  labelKey: 'conversation',
}

const DOCUMENT_VISIBILITIES = ['private', 'project'] as const

const documentDescriptor: ShareableDescriptor = {
  type: 'document',
  probe: async (resourceId) => {
    const row = await findDocumentTenancy(resourceId)
    if (!row) return null
    return {
      organizationId: row.organizationId,
      projectId: row.projectId,
      container: row.projectId
        ? { kind: 'project', id: row.projectId }
        : { kind: 'organization', id: row.organizationId },
      visibility: row.visibility,
      createdBy: row.createdBy,
      // Documents are hard-deleted (0077): a row that exists is live.
      deletedAt: null,
    }
  },
  allowedVisibilities: DOCUMENT_VISIBILITIES,
  defaultVisibility: 'project',
  roles: RESOURCE_ROLES,
  // Mentions about a file happen on a conversation that has the file as
  // subject (spec F7), not on the document resource itself.
  supportsMentions: false,
  setVisibility: async (resourceId, organizationId, visibility) => {
    const row = await updateDocumentVisibilityInOrg(resourceId, organizationId, visibility)
    return row !== null
  },
  describeRef: async (resourceId, organizationId) => {
    const row = await findDocumentTenancy(resourceId)
    if (!row || row.organizationId !== organizationId) return null
    return { title: documentDisplayName(row) }
  },
  exists: (ids) => documentIdsExisting(ids),
  listIdsInProject: (projectId, organizationId) => listDocumentIdsForProject(projectId, organizationId),
  deepLink: (resourceId, options) => {
    if (!options?.projectId) return `/app/archiv?doc=${encodeURIComponent(resourceId)}`
    return `/app/projects/${encodeURIComponent(options.projectId)}/files?doc=${encodeURIComponent(resourceId)}`
  },
  labelKey: 'document',
}

export const SHAREABLE_REGISTRY: Record<ShareableResourceType, ShareableDescriptor> = {
  conversation: conversationDescriptor,
  document: documentDescriptor,
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

/**
 * Validate an untrusted `[resourceType]` path segment against the registry's
 * union.
 *
 * A 400 rather than a 404: an unregistered type is a malformed request, not a
 * resource the caller may not see, and telling them so is not a disclosure —
 * the set of shareable types is public API surface.
 *
 * This was deliberately duplicated across the four sharing routes, on the
 * grounds that a Next.js route module may only export HTTP handlers so a shared
 * helper "would need a module of its own for five lines". That module is this
 * one: the check asks the registry's own question — is this a type I know? —
 * against the registry's own union, alongside `describeResource` and the role
 * ladder. Nothing new was needed, and the four copies were four places to
 * update the day a type is added or the error contract changes.
 */
export function requireShareableType(raw: string): ShareableResourceType {
  const resourceType = SHAREABLE_RESOURCE_TYPES.find((candidate) => candidate === raw)
  if (!resourceType) {
    throw new BadRequestError(`"${raw}" is not a shareable resource type`, {
      allowed: SHAREABLE_RESOURCE_TYPES,
    })
  }
  return resourceType
}
