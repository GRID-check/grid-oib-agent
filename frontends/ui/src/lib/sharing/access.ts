/**
 * Effective-access resolution for shareable resources (ADR-0032, spec SH-4…SH-6).
 *
 * This is the single most security-critical function in the collaboration
 * feature, so the rules are stated here in the order they are enforced:
 *
 *   1. **Tenancy.** The resource must belong to the caller's organization.
 *      Checked FIRST and never bypassed — not even for org admins.
 *   2. **Container access.** The caller must be able to reach the resource's
 *      container (for a conversation: its project). A grant can raise your role
 *      on one resource; it can NEVER hand you the project. This is the formal
 *      version of "you may only invite people already inside project scope".
 *   3. **Effective role = the STRONGEST of** the visibility-derived role and any
 *      explicit grant. Grants are additive only — there is no per-person deny,
 *      because negative permissions make effective access non-composable.
 *
 * Every denial surfaces as `NotFoundError`, so a response never confirms the
 * existence of a resource the caller may not see (spec SH-6) — the same
 * convention `requireProjectAccess` already follows.
 */

import 'server-only'
import { NotFoundError } from '@/lib/api/errors'
import { requireProjectAccess, type ProjectRole } from '@/lib/authz/projects'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { ResourceRole, ResourceVisibility, ShareableResourceType } from '@/lib/db/schema'
import { describeResource, roleSatisfies, strongerRole } from './registry'
import { findGrantForSubject } from './repository'

/** Why a caller has the access they have — surfaced in the roster's "reason" column. */
export type AccessReason =
  /** They created it. */
  | 'creator'
  /** An explicit grant names them. */
  | 'grant'
  /** Visibility is `project` and they can reach the project. */
  | 'visibility-project'
  /** Visibility is `organization` and they are a member. */
  | 'visibility-organization'

export interface ResourceAccess {
  /** Effective role, or null when the caller has none. */
  role: ResourceRole | null
  /** The strongest reason that produced `role` (null when no access). */
  reason: AccessReason | null
  /** The resource's current blanket visibility. */
  visibility: ResourceVisibility
  /** Container, for deep links and for project-scoped follow-up queries. */
  container: { organizationId: string; projectId: string | null }
  /**
   * Whether the caller may ESCALATE themselves to owner. True for project
   * admins, who legitimately need to administer resources in their project but
   * must not hold silent ownership of every private thread in it (spec SH-10).
   * Escalation is a deliberate, audited act.
   */
  canEscalate: boolean
}

/**
 * Map a project role onto a resource role for `project` visibility.
 *
 * A project admin maps to `collaborator`, NOT `owner`: if admins implicitly
 * owned everything, `private` would be a lie. They get `canEscalate` instead.
 */
function roleFromProjectRole(projectRole: ProjectRole): ResourceRole {
  switch (projectRole) {
    // `project-contributor` lands here too: it may run the agent but not change
    // the project's corpus, so on a shared resource it reads rather than edits
    // (ADR-0038), which is the viewer rung. `requireProjectAccess` derives that
    // ladder and does not distinguish the two — see `ProjectRole`.
    case 'project-viewer':
      return 'viewer'
    case 'project-editor':
    case 'project-admin':
      return 'collaborator'
  }
}

/**
 * Resolve what a session may do with a shareable resource.
 *
 * Returns `role: null` for "exists in your org and container, but you have no
 * access" — callers that must deny should use {@link requireResourceAccess},
 * which converts that (and every earlier failure) into a 404.
 *
 * Throws `NotFoundError` when the resource does not exist, belongs to another
 * organization, or its container is unreachable — the three cases that must be
 * indistinguishable from one another.
 */
export async function resolveResourceAccess(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<ResourceAccess> {
  const descriptor = describeResource(resourceType)

  // (1) Tenancy. One probe carries existence, container, visibility and creator.
  const probe = await descriptor.probe(resourceId)
  if (!probe || probe.organizationId !== session.organizationId || probe.deletedAt) {
    throw new NotFoundError()
  }

  const container = { organizationId: probe.organizationId, projectId: probe.projectId }
  const visibility = probe.visibility

  // (2) Container access. A resource inside a project is unreachable to anyone
  // who cannot reach the project, whatever grants exist. Denial from
  // requireProjectAccess is already a NotFoundError, which is what we want.
  let projectRole: ProjectRole | null = null
  if (probe.container.kind === 'project' && probe.container.id) {
    const { role } = await requireProjectAccess(session, probe.container.id, 'project:view')
    projectRole = role
  }

  // (3) Effective role: the strongest of visibility and grant.
  let role: ResourceRole | null = null
  let reason: AccessReason | null = null

  if (visibility === 'project' && projectRole) {
    role = roleFromProjectRole(projectRole)
    reason = 'visibility-project'
  } else if (visibility === 'organization') {
    // Any member of the org — tenancy above already proved membership.
    role = 'collaborator'
    reason = 'visibility-organization'
  }

  const grant = await findGrantForSubject(resourceType, resourceId, session.userId)
  if (grant) {
    const merged = strongerRole(role, grant.role)
    if (merged !== role) reason = 'grant'
    role = merged
  }

  // The creator always owns it — this is what makes a `private` resource
  // reachable by its author, and a legacy unstamped conversation reachable at all.
  if (probe.createdBy && probe.createdBy === session.userId) {
    const merged = strongerRole(role, 'owner')
    if (merged !== role) reason = 'creator'
    role = merged
  }

  return {
    role,
    reason,
    visibility,
    container,
    // Escalation is for a project admin who is NOT already an owner. Offering it
    // to somebody who owns the thread (their own thread, most often) gave them a
    // button that upserts a redundant grant, consumes a roster slot, and writes
    // `resource.ownership.escalated` with `previousRole: 'owner'` — an audit
    // record of an escalation that did not happen.
    canEscalate: projectRole === 'project-admin' && !roleSatisfies(role, 'owner'),
  }
}

/**
 * Authorize a session against a shareable resource, or throw.
 *
 * `minimum` is the weakest role that satisfies the operation:
 *   - `viewer`       — read the resource;
 *   - `collaborator` — contribute to it (post, answer a mention);
 *   - `owner`        — change visibility, manage grants, delete.
 */
export async function requireResourceAccess(
  session: AuthorizedSession,
  resourceType: ShareableResourceType,
  resourceId: string,
  minimum: ResourceRole = 'viewer',
): Promise<ResourceAccess> {
  const access = await resolveResourceAccess(session, resourceType, resourceId)
  if (!roleSatisfies(access.role, minimum)) {
    // Project admins may escalate, but escalation is an explicit action — it
    // does not silently satisfy a check here.
    throw new NotFoundError()
  }
  return access
}

/**
 * Whether a resource counts as SHARED — i.e. whether the server is authoritative
 * for it and live sync applies (ADR-0033). A private resource with no grants is
 * single-player and keeps the existing local-first path.
 */
export function isShared(visibility: ResourceVisibility, grantCount: number): boolean {
  return visibility !== 'private' || grantCount > 0
}
