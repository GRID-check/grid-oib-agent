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
 *     membership; `project`/`skill` go to WorkOS FGA.
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
 *   - resource tiers (`project`, `skill`) → **404 Not found**, so a response
 *     never confirms the existence of something the caller may not see.
 */

import 'server-only'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { GridSession } from '@/lib/auth/types'
import { findJob } from '@/lib/jobs/repository'
import { findPermissionSpec, type PermissionTier } from './catalog'
import { findProjectTenancy } from '@/lib/projects/repository'
import {
  hasPermission,
  ORG_PERMISSIONS,
  type AnyPermission,
  type KnownPermission,
  type PlatformPermission,
  type ProjectPermission,
  type SkillPermission,
} from './permissions'
import { hasPlatformPermission } from './platform'
import { requireProjectAccess } from './projects'
import { checkResourcePermission } from './resource-check'
import type { AuthorizedSession } from '@/lib/auth/types'

/** A resource a decision can be scoped to. Claims tiers need none. */
export type AuthzResource =
  | { readonly type: 'project'; readonly id: string }
  | { readonly type: 'skill'; readonly id: string }

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
 * Whether per-skill FGA resources exist to check against.
 *
 * `false` today and deliberately a named constant rather than a silent omission:
 * the skill tier's permissions and its parent fallback are real and used, only
 * the per-resource grants are unbuilt. Flipping this is one half of shipping
 * them; the other half is creating the resource alongside the job row.
 */
const SKILL_RESOURCES_PROVISIONED = false

/**
 * Project-tier permission that also covers a job action. Same reasoning as
 * WORKFLOW_FALLBACK: the Skill resource (a JOB row since 0043) is a child of
 * Project in the topology, and rather than rely on unverified FGA inheritance
 * semantics, a project admin administers the jobs in their project because they
 * hold `project:skills:manage`, and anyone who can see the project can see that
 * its jobs exist.
 */
const SKILL_FALLBACK: Record<SkillPermission, ProjectPermission> = {
  'skill:view': 'project:view',
  'skill:run': 'project:skills:manage',
  'skill:manage': 'project:skills:manage',
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
    // permission a tenant role could carry — but WHICH platform permission the
    // membership's role holds still decides, or the read-only
    // `org-platform-support` role would pass every write gate.
    // `hasPlatformPermission` also covers the audited break-glass allowlist.
    return (await hasPlatformPermission(session, permission as PlatformPermission))
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
      // `requireProjectAccess` collapses "not in your organization" and "no
      // grant" into the same NotFoundError on purpose — the response must not
      // distinguish them. The DECISION may, and should: an operator reading the
      // trail needs to know which one happened. One extra tenancy probe, only on
      // the denial path, so the allow path is unchanged.
      const tenancy = await findProjectTenancy(resource.id)
      // A soft-deleted project is unreachable for everyone, including the org
      // admins who bypass FGA — so labelling that denial `no-grant` is as
      // untruthful as the label this branch was written to fix. It is the
      // resource being gone, not a missing grant.
      const mismatched =
        !tenancy ||
        tenancy.organizationId !== authorized.organizationId ||
        Boolean(tenancy.deletedAt)
      return deny(permission, 'project', mismatched ? 'tenancy-mismatch' : 'no-grant', resource)
    }
    throw error
  }
  return allow(
    permission,
    'project',
    // Which rule allowed it. The bypass is a permission, so ask the permission —
    // asking `session.role === 'admin'` would mislabel a custom org role that
    // legitimately holds `org:projects:administer`.
    hasPermission(session, ORG_PERMISSIONS.projectsAdminister)
      ? 'org-admin-bypass'
      : 'resource-role',
    resource
  )
}

/**
 * Skill tier — tenancy from the `jobs` row, then the job's own FGA role, then
 * the project-tier fallback above. Identical shape to the workflow tier; the
 * job is the resource, and its project carries the fallback permissions. The
 * tier keeps the name `skill` because that is the FGA resource type slug.
 */
async function decideSkillTier(
  session: GridSession,
  permission: SkillPermission,
  resource: AuthzResource
): Promise<AuthzDecision> {
  const authorized = asAuthorized(session)
  if (!authorized) return deny(permission, 'skill', 'no-organization', resource)

  // Tenancy first, and never bypassed: the row is looked up scoped to the
  // caller's organization, so a job id from another tenant is absent.
  const job = await findJob(resource.id, authorized.organizationId)
  if (!job) return deny(permission, 'skill', 'tenancy-mismatch', resource)

  // Per-skill FGA is only asked when there is something it could answer.
  //
  // Nothing in the app creates a `skill` FGA resource — `createResource` is
  // called for projects and nothing else — and the catalog defines no
  // skill-tier ROLE, so no membership can hold `skill:*` on anything. Asking
  // WorkOS anyway was a guaranteed-false round-trip plus a warning line on every
  // skill decision, which reads in the logs like a broken authorization check
  // rather than an unbuilt feature. When per-skill grants ship, this predicate
  // is where they turn on.
  if (SKILL_RESOURCES_PROVISIONED) {
    const granted = await checkResourcePermission({
      organizationMembershipId: authorized.organizationMembershipId,
      permissionSlug: permission,
      resourceExternalId: resource.id,
      resourceTypeSlug: 'skill',
    })
    if (granted) return allow(permission, 'skill', 'resource-role', resource)
  }

  // Parent fallback: the project role that covers this job action.
  const viaProject = await decideProjectTier(session, SKILL_FALLBACK[permission], {
    type: 'project',
    id: job.projectId,
  })
  return viaProject.allowed
    ? allow(permission, 'skill', 'project-inherited', resource)
    : deny(permission, 'skill', 'no-grant', resource)
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
    : decideSkillTier(session, permission as SkillPermission, resource)
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
