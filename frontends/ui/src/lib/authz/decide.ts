/**
 * The Policy Decision Point — ONE place that answers
 * "may this subject perform this action on this resource?" (ADR-0038).
 *
 * Before this module GRID had three authorization engines with three
 * vocabularies, three admin-bypass rules and no shared entry point:
 *
 *   1. WorkOS org roles + JWT permission claims (`org:*`, `platform:*`)
 *   2. WorkOS FGA, per project (`project:*`)
 *   3. Homegrown Postgres grants, per conversation (`lib/sharing/*`)
 *
 * Those engines still exist and are still the right tools — a per-conversation
 * grant model with additive visibility is genuinely more expressive than FGA
 * roles, and JWT claims are genuinely faster than a network check. What was
 * missing was a single front door, so that every gate is asked the same way,
 * every denial names the rule that produced it, and coverage can be audited.
 * This module is that front door; the engines became implementation details.
 *
 * ## The rules, in the order they are applied
 *
 *  1. **Session.** No session, no decision. Never falls through to "allow".
 *  2. **Tenancy.** For a resource tier, the resource must belong to the
 *     caller's active organization. Checked FIRST and bypassed by nobody —
 *     not platform owners, not org admins.
 *  3. **Tier dispatch.** `org`/`platform` are answered from claims and
 *     membership; `project`/`workflow` go to WorkOS FGA.
 *  4. **Named bypasses.** Org admins reach every project in their own
 *     organization, and platform owners reach the platform tier. Both are
 *     deliberate product decisions, and both now surface as a NAMED rule on the
 *     decision rather than an anonymous `if` buried in a service.
 *
 * ## Denial shape
 *
 * `authorize()` throws the error each tier already threw, so migrating a call
 * site changes no response:
 *   - claims tiers (`org`, `platform`) → **403 Forbidden**
 *   - resource tiers (`project`, `workflow`) → **404 Not found**, so a response
 *     never confirms the existence of something the caller may not see.
 */

import 'server-only'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { GridSession } from '@/lib/auth/types'
import { findWorkflow } from '@/lib/workflows/repository'
import { findPermissionSpec, type PermissionTier } from './catalog'
import {
  hasPermission,
  type AnyPermission,
  type KnownPermission,
  type ProjectPermission,
  type WorkflowPermission,
} from './permissions'
import { isPlatformOwner } from './platform'
import { requireProjectAccess } from './projects'
import { checkResourcePermission } from './resource-check'
import type { AuthorizedSession } from '@/lib/auth/types'

/** A resource a decision can be scoped to. Claims tiers need none. */
export type AuthzResource =
  | { readonly type: 'project'; readonly id: string }
  | { readonly type: 'workflow'; readonly id: string }

/**
 * The named rule that produced a decision. Every allow and every deny carries
 * one, so an authorization outcome is explainable without re-reading the code —
 * and so a bypass can never be silent.
 */
export type AuthzRule =
  /** No session at all. */
  | 'no-session'
  /** Session has no active organization, so no tenant-scoped answer exists. */
  | 'no-organization'
  /** The JWT `permissions` claim names the permission. */
  | 'jwt-permission'
  /** Bounded legacy implication from the role slug (see `./permissions`). */
  | 'legacy-role-implication'
  /** Platform-org membership (or the audited break-glass allowlist). */
  | 'platform-membership'
  /** Org admins reach every project in their OWN organization. */
  | 'org-admin-bypass'
  /** A per-resource FGA role grants it. */
  | 'resource-role'
  /** A project-tier permission covers the workflow action (parent fallback). */
  | 'project-inherited'
  /** The resource is not in the caller's organization, or does not exist. */
  | 'tenancy-mismatch'
  /** Nothing granted it. */
  | 'no-grant'

export interface AuthzDecision {
  readonly allowed: boolean
  readonly rule: AuthzRule
  readonly permission: AnyPermission
  readonly tier: PermissionTier
  /** Set when a resource tier decided; useful for audit and logging. */
  readonly resource?: AuthzResource
}

/**
 * Project-tier permission that also covers a workflow action.
 *
 * The Workflow resource type is a CHILD of Project in WorkOS, but rather than
 * rely on FGA inheritance semantics we have not verified against the live API,
 * the fallback is explicit here: a project admin administers the workflows in
 * their project because they hold `project:workflows:manage`, and anyone who can
 * see the project can see that its workflows exist.
 */
const WORKFLOW_FALLBACK: Record<WorkflowPermission, ProjectPermission> = {
  'workflow:view': 'project:view',
  'workflow:run': 'project:workflows:manage',
  'workflow:manage': 'project:workflows:manage',
}

/**
 * Narrow a session to one with an active organization, or `null`.
 *
 * Every resource tier needs both the organization (for tenancy) and the
 * membership (the identity WorkOS resolves FGA roles against); a session
 * missing either cannot produce a tenant-scoped answer at all.
 */
function asAuthorized(session: GridSession): AuthorizedSession | null {
  const { organizationId, organizationMembershipId, role } = session
  if (!organizationId || !organizationMembershipId) return null
  return { ...session, organizationId, organizationMembershipId, role: role ?? '' }
}

function tierOf(permission: AnyPermission): PermissionTier {
  const spec = findPermissionSpec(permission)
  if (!spec) {
    // Unknown slug: fail closed rather than guess a tier from its prefix.
    throw new Error(`[authz] permission "${permission}" is not in the catalog`)
  }
  return spec.tier
}

function deny(
  permission: AnyPermission,
  tier: PermissionTier,
  rule: AuthzRule,
  resource?: AuthzResource
): AuthzDecision {
  return { allowed: false, rule, permission, tier, resource }
}

function allow(
  permission: AnyPermission,
  tier: PermissionTier,
  rule: AuthzRule,
  resource?: AuthzResource
): AuthzDecision {
  return { allowed: true, rule, permission, tier, resource }
}

/** Claims tiers: answered from the JWT plus (for platform) one cached lookup. */
async function decideClaimsTier(
  session: GridSession,
  permission: KnownPermission,
  tier: PermissionTier
): Promise<AuthzDecision> {
  if (tier === 'platform') {
    // Platform access is membership of the platform organization, never a
    // permission a tenant role could carry. `isPlatformOwner` also covers the
    // audited break-glass allowlist.
    return (await isPlatformOwner(session))
      ? allow(permission, tier, 'platform-membership')
      : deny(permission, tier, 'no-grant')
  }

  if (session.permissions.includes(permission)) {
    return allow(permission, tier, 'jwt-permission')
  }
  // `hasPermission` also consults the bounded catalog-derived implication for
  // sessions minted before a permission was provisioned.
  return hasPermission(session, permission)
    ? allow(permission, tier, 'legacy-role-implication')
    : deny(permission, tier, 'no-grant')
}

/**
 * Project tier — delegates to `requireProjectAccess`, which owns the tenancy
 * check, the org-admin bypass and the FGA round-trip (plus its optional cache).
 * Reimplementing any of that here would be a second, divergent copy of the most
 * security-critical check in the app.
 */
async function decideProjectTier(
  session: GridSession,
  permission: ProjectPermission,
  resource: AuthzResource
): Promise<AuthzDecision> {
  const authorized = asAuthorized(session)
  if (!authorized) return deny(permission, 'project', 'no-organization', resource)
  try {
    await requireProjectAccess(authorized, resource.id, permission)
  } catch (error) {
    if (error instanceof NotFoundError) {
      return deny(permission, 'project', 'no-grant', resource)
    }
    throw error
  }
  return allow(
    permission,
    'project',
    session.role === 'admin' ? 'org-admin-bypass' : 'resource-role',
    resource
  )
}

/**
 * Workflow tier — tenancy from the workflow row, then the workflow's own FGA
 * role, then the project-tier fallback above.
 */
async function decideWorkflowTier(
  session: GridSession,
  permission: WorkflowPermission,
  resource: AuthzResource
): Promise<AuthzDecision> {
  const authorized = asAuthorized(session)
  if (!authorized) return deny(permission, 'workflow', 'no-organization', resource)

  // Tenancy first, and never bypassed: the row is looked up scoped to the
  // caller's organization, so a workflow id from another tenant is simply absent.
  const workflow = await findWorkflow(resource.id, authorized.organizationId)
  if (!workflow) return deny(permission, 'workflow', 'tenancy-mismatch', resource)

  const granted = await checkResourcePermission({
    organizationMembershipId: authorized.organizationMembershipId,
    permissionSlug: permission,
    resourceExternalId: resource.id,
    resourceTypeSlug: 'workflow',
  })
  if (granted) return allow(permission, 'workflow', 'resource-role', resource)

  // Parent fallback: the project role that covers this workflow action.
  const viaProject = await decideProjectTier(session, WORKFLOW_FALLBACK[permission], {
    type: 'project',
    id: workflow.projectId,
  })
  return viaProject.allowed
    ? allow(permission, 'workflow', 'project-inherited', resource)
    : deny(permission, 'workflow', 'no-grant', resource)
}

/**
 * Decide whether `session` may perform `permission`, optionally on `resource`.
 *
 * Pure decision: returns rather than throws, so callers that need to branch
 * (a UI capability flag, a filtered listing) do not pay for exception control
 * flow. Use {@link authorize} at enforcement points.
 */
export async function decide(
  session: GridSession | null,
  permission: AnyPermission,
  resource?: AuthzResource
): Promise<AuthzDecision> {
  const tier = tierOf(permission)
  if (!session) return deny(permission, tier, 'no-session', resource)

  if (tier === 'org' || tier === 'platform') {
    return decideClaimsTier(session, permission as KnownPermission, tier)
  }

  if (!resource) {
    throw new Error(`[authz] permission "${permission}" is ${tier}-tier and requires a resource`)
  }
  if (resource.type !== tier) {
    throw new Error(
      `[authz] permission "${permission}" is ${tier}-tier but was given a ${resource.type} resource`
    )
  }

  return tier === 'project'
    ? decideProjectTier(session, permission as ProjectPermission, resource)
    : decideWorkflowTier(session, permission as WorkflowPermission, resource)
}

/** True when the session holds the permission. Sugar over {@link decide}. */
export async function can(
  session: GridSession | null,
  permission: AnyPermission,
  resource?: AuthzResource
): Promise<boolean> {
  return (await decide(session, permission, resource)).allowed
}

/**
 * Enforce a permission, throwing the error that tier already threw:
 * 403 for claims tiers, 404 for resource tiers (no existence oracle).
 */
export async function authorize(
  session: GridSession | null,
  permission: AnyPermission,
  resource?: AuthzResource
): Promise<AuthzDecision> {
  const decision = await decide(session, permission, resource)
  if (decision.allowed) return decision
  if (decision.tier === 'org' || decision.tier === 'platform') throw new ForbiddenError()
  throw new NotFoundError()
}
