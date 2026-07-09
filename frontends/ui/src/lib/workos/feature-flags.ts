/**
 * WorkOS feature-flag evaluation (server-side).
 *
 * `listOrganizationFeatureFlags` returns the flags **enabled** for an
 * organization, so membership of a slug == "on for this org". Results are cached
 * briefly per org to avoid a WorkOS round-trip on every WebSocket upgrade.
 *
 * Fail-closed: any error (no API key, feature not on the plan, network) returns
 * the caller's default (off), so a flag outage never silently enables a gated
 * capability.
 */

import { getWorkOS } from './client'
import { getCached, invalidateCached } from '@/lib/cache'

/** Slug of the flag gating the async post-answer memory-reflection stage. */
export const MEMORY_REFLECTION_FLAG = 'memory-reflection'

const CACHE_TTL_MS = 30_000

async function enabledSlugsForOrg(organizationId: string): Promise<Set<string>> {
  const slugs = await getCached(`flags:${organizationId}`, CACHE_TTL_MS, async () => {
    const list = await getWorkOS().featureFlags.listOrganizationFeatureFlags({ organizationId })
    return (list.data ?? []).map((flag) => flag.slug)
  })
  return new Set(slugs)
}

/**
 * Whether `slug` is enabled for `organizationId`. Returns `defaultValue` when
 * there is no org, no WorkOS API key, or evaluation fails (fail-closed).
 */
export async function isOrgFeatureEnabled(
  slug: string,
  organizationId: string | null | undefined,
  defaultValue = false,
): Promise<boolean> {
  if (!organizationId || !process.env.WORKOS_API_KEY) {
    return defaultValue
  }
  try {
    return (await enabledSlugsForOrg(organizationId)).has(slug)
  } catch (error) {
    console.warn(`[FeatureFlags] evaluation of "${slug}" failed; using default (${defaultValue})`, error)
    return defaultValue
  }
}

/** Test hook: clear a specific org's flag cache entry. */
export async function _clearFeatureFlagCache(organizationId?: string): Promise<void> {
  if (organizationId) {
    await invalidateCached(`flags:${organizationId}`)
  }
}
