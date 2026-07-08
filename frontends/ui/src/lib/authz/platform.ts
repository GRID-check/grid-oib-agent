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
 * A session counts as platform owner when:
 *  1. its ACTIVE org is the platform org and the JWT carries a `platform:*`
 *     permission (fast path, pure claims), or
 *  2. the user holds an active platform-org membership with the
 *     `org-platform-owner` role (cross-org path — the owner browsing a
 *     tenant org; one WorkOS lookup, cached), or
 *  3. break-glass bootstrap: their email is in GRID_PLATFORM_OWNER_EMAILS
 *     (documented in docs/deployment/workos-provisioning.md; intended for
 *     first-run in a fresh environment before provisioning).
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import { recordAuditEvent } from '@/lib/audit/service'
import { PLATFORM_PERMISSIONS } from './permissions'
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
const membershipCache = new Map<string, { fetchedAt: number; isOwner: boolean }>()

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
    `[Platform Authz] break-glass platform access granted to ${session.email} via GRID_PLATFORM_OWNER_EMAILS`,
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
    const ttl = platformOrgCache.organizationId ? PLATFORM_ORG_CACHE_TTL_MS : PLATFORM_ORG_NEGATIVE_TTL_MS
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

async function hasPlatformMembership(userId: string, platformOrgId: string): Promise<boolean> {
  const cacheKey = `${userId}:${platformOrgId}`
  const cached = membershipCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < MEMBERSHIP_CACHE_TTL_MS) {
    return cached.isOwner
  }
  let isOwner = false
  try {
    const workos = getWorkOS()
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId,
      organizationId: platformOrgId,
      statuses: ['active'],
      limit: 1,
    })
    isOwner = memberships.data.some((membership) => membership.role?.slug === PLATFORM_OWNER_ROLE_SLUG)
  } catch {
    isOwner = false // fail closed
  }
  // Bounded: the cache only ever needs the handful of would-be owners, but
  // every signed-in user probes it once per TTL — clear rather than grow.
  if (membershipCache.size >= MEMBERSHIP_CACHE_MAX_ENTRIES) {
    membershipCache.clear()
  }
  membershipCache.set(cacheKey, { fetchedAt: Date.now(), isOwner })
  return isOwner
}

/** True when this session belongs to the platform owner. */
export async function isPlatformOwner(session: GridSession | null): Promise<boolean> {
  if (!session) return false

  // Break-glass bootstrap for fresh environments — always audited.
  if (session.email && bootstrapEmails().includes(session.email.toLowerCase())) {
    await auditBreakGlassUse(session)
    return true
  }

  const platformOrgId = await getPlatformOrganizationId()
  if (!platformOrgId) return false

  // Fast path: acting inside the platform org — trust the JWT claims.
  if (session.organizationId === platformOrgId) {
    return (
      session.role === PLATFORM_OWNER_ROLE_SLUG ||
      session.permissions.includes(PLATFORM_PERMISSIONS.organizationsView)
    )
  }

  // Cross-org path: the owner browsing a tenant org.
  return hasPlatformMembership(session.userId, platformOrgId)
}

/** Typed denial — consumers map it to 403 explicitly (no string matching). */
export class PlatformAccessDeniedError extends Error {
  readonly status = 403
  constructor() {
    super('Platform owner access required')
    this.name = 'PlatformAccessDeniedError'
  }
}

/** Throws PlatformAccessDeniedError unless the session is the platform owner. */
export async function requirePlatformOwner(session: GridSession | null): Promise<void> {
  if (!(await isPlatformOwner(session))) {
    throw new PlatformAccessDeniedError()
  }
}

/** Test hook. */
export function _clearPlatformCaches(): void {
  platformOrgCache = null
  membershipCache.clear()
  breakGlassAuditedAt.clear()
}
