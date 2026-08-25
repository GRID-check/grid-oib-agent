/**
 * Platform-tier authorization (ADR-0016).
 *
 * The platform tier is modeled as a dedicated WorkOS organization
 * ("GRID Platform", external id `grid-platform`) with an ORG-SCOPED role
 * `org-platform-owner` holding the `platform:*` permissions. WorkOS cannot
 * express a resource type above its Organization root (verified: creating a
 * parentless type and re-parenting Organization are both rejected), so the
 * org-scoped role IS the WorkOS-native way to model staff/platform access:
 * the role only exists inside the platform org, which makes it structurally
 * unassignable by tenant admins — exclusivity enforced by WorkOS itself.
 *
 * ## Membership is the precondition; the permission is the decision
 *
 * This module answers two different questions and they must not be confused:
 *
 *  - {@link isPlatformStaff} — may this session reach the platform tier AT ALL?
 *    That is membership of the platform organization (or break-glass), and it is
 *    what the nav flag and the route factory's precondition rest on.
 *  - {@link platformPermissions} / {@link requirePlatformPermission} — WHICH
 *    platform permission does it hold? Every platform surface asks this, because
 *    `org-platform-support` is defined as read-only and a single binary gate
 *    cannot express that. It used to be one binary, and Support consequently
 *    held write on every mutating platform route.
 *
 * A session holds platform permissions when:
 *  1. its ACTIVE org is the platform org — the permissions are its JWT claims,
 *    plus the bounded catalog implication for its role slug (fast path, no I/O);
 *  2. it holds an active platform-org membership while browsing a TENANT org —
 *    the permissions are that membership's role's, resolved from WorkOS and
 *    cached. Any platform-org role counts, not only `org-platform-owner`:
 *    Support was previously invisible on this path and got nothing at all; or
 *  3. break-glass bootstrap: their email is in GRID_PLATFORM_OWNER_EMAILS
 *     (documented in docs/deployment/workos-provisioning.md; intended for
 *     first-run in a fresh environment before provisioning). Break-glass grants
 *     every platform permission, and is always audited.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import { recordAuditEvent } from '@/lib/audit/service'
import { organizationRolePermissions } from './org-role-permissions'
import {
  ALL_PLATFORM_PERMISSION_SLUGS,
  permissionsForPlatformRole,
  type PlatformPermission,
} from './permissions'
import type { GridSession } from '@/lib/auth/types'

export const PLATFORM_ORG_EXTERNAL_ID = process.env.GRID_PLATFORM_ORG_EXTERNAL_ID ?? 'grid-platform'
export const PLATFORM_OWNER_ROLE_SLUG = 'org-platform-owner'

const MEMBERSHIP_CACHE_TTL_MS = 60_000
const PLATFORM_ORG_CACHE_TTL_MS = 300_000
// A *missing* platform org is cached briefly so provisioning takes effect
// quickly (runbook first-run), while the found id can live longer.
const PLATFORM_ORG_NEGATIVE_TTL_MS = 30_000
const MEMBERSHIP_CACHE_MAX_ENTRIES = 500

let platformOrgCache: { fetchedAt: number; organizationId: string | null } | null = null
/**
 * Cached platform-org membership, as the PERMISSION SET it confers.
 *
 * Was a boolean `isOwner`, which is what made Support invisible on this path:
 * the only question it could answer was "is this the owner role", so a session
 * holding a different platform-org role got nothing at all while browsing a
 * tenant org. `null` means "not a member" and is cached the same way, so a
 * non-member still costs one lookup per TTL rather than one per request.
 */
const membershipCache = new Map<
  string,
  { fetchedAt: number; permissions: ReadonlySet<string> | null }
>()

// Break-glass access is evaluated on every authz check; audit it at most
// once per actor per hour so the trail shows env-var access without flooding.
const BREAK_GLASS_AUDIT_INTERVAL_MS = 60 * 60 * 1000
const breakGlassAuditedAt = new Map<string, number>()

async function auditBreakGlassUse(session: GridSession): Promise<void> {
  // Keyed per actor AND active org: an owner hopping across tenant orgs
  // inside the window leaves one trail entry per org, not one total —
  // cross-org break-glass access is exactly what must stay visible.
  const throttleKey = `${session.userId}:${session.organizationId ?? 'none'}`
  const last = breakGlassAuditedAt.get(throttleKey)
  if (last && Date.now() - last < BREAK_GLASS_AUDIT_INTERVAL_MS) return
  breakGlassAuditedAt.set(throttleKey, Date.now())
  console.warn(
    `[Platform Authz] break-glass platform access granted to ${session.email} via GRID_PLATFORM_OWNER_EMAILS`
  )
  // WorkOS audit events are org-scoped — break-glass lands in the platform
  // org's trail. During true first-run (no platform org yet) only the log
  // line above exists; the runbook says to clear the allowlist afterwards.
  const platformOrgId = await getPlatformOrganizationId()
  if (platformOrgId) {
    await recordAuditEvent({
      organizationId: platformOrgId,
      actor: { userId: session.userId, email: session.email },
      action: 'platform.access.break_glass',
      targetType: 'platform',
      targetId: platformOrgId,
      metadata: { activeOrganizationId: session.organizationId },
    })
  }
}

/** Resolve (and cache) the platform organization's WorkOS id. */
export async function getPlatformOrganizationId(): Promise<string | null> {
  if (platformOrgCache) {
    const ttl = platformOrgCache.organizationId
      ? PLATFORM_ORG_CACHE_TTL_MS
      : PLATFORM_ORG_NEGATIVE_TTL_MS
    if (Date.now() - platformOrgCache.fetchedAt < ttl) {
      return platformOrgCache.organizationId
    }
  }
  try {
    const workos = getWorkOS()
    const org = await workos.organizations.getOrganizationByExternalId(PLATFORM_ORG_EXTERNAL_ID)
    platformOrgCache = { fetchedAt: Date.now(), organizationId: org.id }
  } catch {
    // Not provisioned (or WorkOS hiccup) — cache the miss briefly, fail closed.
    platformOrgCache = { fetchedAt: Date.now(), organizationId: null }
  }
  return platformOrgCache.organizationId
}

function bootstrapEmails(): string[] {
  return (process.env.GRID_PLATFORM_OWNER_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * The permissions a user's platform-org membership confers, or `null` when they
 * hold no active membership. **Fails closed**: any lookup error is `null`.
 */
async function platformMembershipPermissions(
  userId: string,
  platformOrgId: string
): Promise<ReadonlySet<string> | null> {
  const cacheKey = `${userId}:${platformOrgId}`
  const cached = membershipCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < MEMBERSHIP_CACHE_TTL_MS) {
    return cached.permissions
  }
  let permissions: ReadonlySet<string> | null = null
  try {
    const workos = getWorkOS()
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId,
      organizationId: platformOrgId,
      statuses: ['active'],
      limit: 1,
    })
    const roleSlug = memberships.data[0]?.role?.slug ?? null
    if (roleSlug) {
      // What the role HOLDS, asked of WorkOS (cached, catalog fallback) — not
      // inferred from its slug. `org-platform-support` is a platform-org role
      // like any other; matching one hardcoded name is what hid it here.
      permissions = await organizationRolePermissions(platformOrgId, roleSlug)
    }
  } catch {
    permissions = null // fail closed
  }
  // Bounded: the cache only ever needs the handful of platform staff, but
  // every signed-in user probes it once per TTL — clear rather than grow.
  if (membershipCache.size >= MEMBERSHIP_CACHE_MAX_ENTRIES) {
    membershipCache.clear()
  }
  membershipCache.set(cacheKey, { fetchedAt: Date.now(), permissions })
  return permissions
}

/**
 * Every platform permission this session holds, or `null` when it is not
 * platform staff at all.
 *
 * `null` and the empty set mean different things and both are reachable: `null`
 * is "no platform membership", an empty set is "a member whose role holds
 * nothing", and only the first should read as *not staff*.
 */
export async function platformPermissions(
  session: GridSession | null
): Promise<ReadonlySet<string> | null> {
  if (!session) return null

  // Break-glass bootstrap for fresh environments — always audited, and total:
  // it exists to recover an environment whose provisioning has not run, so a
  // partial grant would leave the recovery half-usable.
  if (session.email && bootstrapEmails().includes(session.email.toLowerCase())) {
    await auditBreakGlassUse(session)
    return new Set(ALL_PLATFORM_PERMISSION_SLUGS)
  }

  const platformOrgId = await getPlatformOrganizationId()
  if (!platformOrgId) return null

  // Fast path: acting inside the platform org — the claims are the answer, with
  // the bounded catalog implication covering a session minted before a platform
  // permission was provisioned (the same rule `hasPermission` applies org-side).
  if (session.organizationId === platformOrgId) {
    const claimed = session.permissions.filter((permission) =>
      (ALL_PLATFORM_PERMISSION_SLUGS as readonly string[]).includes(permission)
    )
    const implied = permissionsForPlatformRole(session.role)
    if (claimed.length === 0 && implied.size === 0) return null
    return new Set([...claimed, ...implied])
  }

  // Cross-org path: platform staff browsing a tenant org.
  return platformMembershipPermissions(session.userId, platformOrgId)
}

/**
 * True when this session may reach the platform tier at all.
 *
 * The PRECONDITION, not the decision — it says the caller is platform staff, not
 * that they may perform the action in front of them. Use it for the nav flag and
 * as the factory's first gate; use {@link requirePlatformPermission} to
 * authorize an actual surface.
 */
export async function isPlatformStaff(session: GridSession | null): Promise<boolean> {
  const permissions = await platformPermissions(session)
  return permissions !== null && permissions.size > 0
}

/**
 * True when this session holds one specific platform permission.
 */
export async function hasPlatformPermission(
  session: GridSession | null,
  permission: PlatformPermission
): Promise<boolean> {
  const permissions = await platformPermissions(session)
  return permissions?.has(permission) ?? false
}

/** Typed denial — consumers map it to 403 explicitly (no string matching). */
export class PlatformAccessDeniedError extends Error {
  readonly status = 403
  constructor(message = 'Platform owner access required') {
    super(message)
    this.name = 'PlatformAccessDeniedError'
  }
}

/**
 * Throws PlatformAccessDeniedError unless the session holds `permission`.
 *
 * This is the gate every platform surface should use. The old
 * `requirePlatformPermission` asked only whether the caller was platform staff, which
 * meant the read-only `org-platform-support` role passed the gate on eleven
 * mutating routes.
 */
export async function requirePlatformPermission(
  session: GridSession | null,
  permission: PlatformPermission
): Promise<void> {
  if (!(await hasPlatformPermission(session, permission))) {
    throw new PlatformAccessDeniedError(`Platform permission required: ${permission}`)
  }
}

/** Test hook. */
export function _clearPlatformCaches(): void {
  platformOrgCache = null
  membershipCache.clear()
  breakGlassAuditedAt.clear()
}
