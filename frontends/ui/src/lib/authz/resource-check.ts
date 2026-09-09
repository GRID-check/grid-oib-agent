/**
 * The one WorkOS FGA round-trip, shared by every resource tier (ADR-0038).
 *
 * Project and skill checks were about to grow two copies of the same
 * instrumentation + optional-cache logic. They get one instead, so a change to
 * the caching posture (or to how a stalled check names itself in the logs)
 * cannot apply to one tier and silently miss the other.
 *
 * **Fails closed**: any transport or SDK error resolves to `false`. An
 * authorization check that cannot complete is a denial, never a default-allow.
 */

import 'server-only'
import { getCached } from '@/lib/cache'
import { getWorkOS } from '@/lib/workos/client'
import { timedWorkOSCall } from '@/lib/workos/instrumentation'

export interface ResourceCheckInput {
  /** The (user, organization) identity WorkOS resolves roles against. */
  readonly organizationMembershipId: string
  /**
   * The caller's organization. Part of the cache key (never omitted — absent
   * renders as the literal `no-org` segment), so a verdict cached for one
   * tenant is never served to another.
   */
  readonly organizationId?: string | null
  readonly permissionSlug: string
  readonly resourceExternalId: string
  readonly resourceTypeSlug: 'project' | 'skill'
}

/**
 * Short-TTL cache of `authorization.check` results.
 *
 * `GRID_AUTHZ_CACHE_TTL_MS` (default `30000`; `0` switches it OFF) caches the
 * boolean result for (organizationMembershipId, resourceType, resourceId,
 * permission). On by default since 2026-09: the websocket-scope route and every
 * project save paid up to three WorkOS round-trips per request for a grant
 * that changes a few times a year.
 *
 * Security tradeoff, accepted with the default:
 *   - A grant or revocation propagates up to TTL later. Keep it short (30–60s),
 *     matching the existing feature-flag cache.
 *   - Tenancy is enforced IN the key, not around it: the key shape is
 *     `authz:check:{org}:{membership}:{type}:{id}:{perm}`, with the literal
 *     segment `no-org` when the caller has no organization. A resource can
 *     never be served across-org from cache — the per-resource grant is cached
 *     only within the (org, membership) that earned it — and the segment is
 *     always present so a caller that forgets the org cannot collide with one
 *     that passed it. Tenancy itself is still checked on every request against
 *     Postgres before this cache is consulted.
 *   - Error-induced denials are NEVER cached (see below): only completed
 *     WorkOS answers populate the entry.
 *   - Org admins bypass FGA before this cache is consulted, so an admin
 *     grant/revoke is unaffected.
 */
export const DEFAULT_AUTHZ_CACHE_TTL_MS = 30_000

export function authzCacheTtlMs(): number {
  const raw = process.env.GRID_AUTHZ_CACHE_TTL_MS
  if (raw === undefined || raw === '') return DEFAULT_AUTHZ_CACHE_TTL_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Ask WorkOS whether a membership holds `permissionSlug` on one resource.
 *
 * Every round-trip is timed, so a stalled check names itself in the logs (the
 * fast path stays silent — see `timedWorkOSCall`).
 */
export async function checkResourcePermission(input: ResourceCheckInput): Promise<boolean> {
  const {
    organizationMembershipId,
    organizationId,
    permissionSlug,
    resourceExternalId,
    resourceTypeSlug,
  } = input

  // Transport/SDK errors THROW out of the loader: `getCached` only stores
  // loader RESULTS, never rejections, so an error-induced denial cannot poison
  // the entry for a full TTL. The fail-closed `false` is applied OUTSIDE the
  // cache (below), without writing anything.
  const liveCheck = () =>
    timedWorkOSCall(`authorization.check ${permissionSlug}`, () =>
      getWorkOS()
        .authorization.check({
          organizationMembershipId,
          permissionSlug,
          resourceExternalId,
          resourceTypeSlug,
        })
        .then((result) => result.authorized)
    )

  const ttlMs = authzCacheTtlMs()
  try {
    if (ttlMs <= 0) return await liveCheck()
    // The store is fail-open by design: a cache outage degrades to a live check.
    return await getCached(
      `authz:check:${organizationId ?? 'no-org'}:${organizationMembershipId}:${resourceTypeSlug}:${resourceExternalId}:${permissionSlug}`,
      ttlMs,
      liveCheck
    )
  } catch (error) {
    // Fail closed. A check that did not complete is not an allow — and, by
    // construction above, this `false` is never cached.
    console.warn(
      `[authz] FGA check failed for ${permissionSlug} on ${resourceTypeSlug}:${resourceExternalId}:`,
      error
    )
    return false
  }
}
