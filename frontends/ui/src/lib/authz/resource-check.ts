/**
 * The one WorkOS FGA round-trip, shared by every resource tier (ADR-0038).
 *
 * Project and workflow checks were about to grow two copies of the same
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
  readonly permissionSlug: string
  readonly resourceExternalId: string
  readonly resourceTypeSlug: 'project' | 'workflow' | 'skill'
}

/**
 * Optional short-TTL cache of `authorization.check` results.
 *
 * `GRID_AUTHZ_CACHE_TTL_MS` (default `0` = OFF) caches the boolean result for
 * (organizationMembershipId, resourceType, resourceId, permission).
 *
 * Security tradeoff, accepted only when explicitly enabled:
 *   - A grant or revocation propagates up to TTL later. Keep it short (30–60s),
 *     matching the existing feature-flag cache.
 *   - Tenancy is NEVER cached — callers check it on every request against
 *     Postgres — so a resource can never be served across-org from cache; only
 *     the per-resource grant within the caller's own org is cached.
 *   - Org admins bypass FGA before this cache is consulted, so an admin
 *     grant/revoke is unaffected.
 */
export function authzCacheTtlMs(): number {
  const raw = process.env.GRID_AUTHZ_CACHE_TTL_MS
  if (raw === undefined || raw === '') return 0
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
  const { organizationMembershipId, permissionSlug, resourceExternalId, resourceTypeSlug } = input

  const run = () =>
    timedWorkOSCall(`authorization.check ${permissionSlug}`, () =>
      getWorkOS()
        .authorization.check({
          organizationMembershipId,
          permissionSlug,
          resourceExternalId,
          resourceTypeSlug,
        })
        .then((result) => result.authorized)
        .catch((error) => {
          // Fail closed. A check that did not complete is not an allow.
          console.warn(
            `[authz] FGA check failed for ${permissionSlug} on ${resourceTypeSlug}:${resourceExternalId}:`,
            error
          )
          return false
        })
    )

  const ttlMs = authzCacheTtlMs()
  if (ttlMs <= 0) return run()

  // The store is fail-open by design: a cache outage degrades to a live check.
  return getCached(
    `authz:check:${organizationMembershipId}:${resourceTypeSlug}:${resourceExternalId}:${permissionSlug}`,
    ttlMs,
    run
  )
}
