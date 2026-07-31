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
import { enforcementOn } from '@/lib/authz/feature-flags'

/** Slug of the flag gating the async post-answer memory-reflection stage. */
export const MEMORY_REFLECTION_FLAG = 'memory-reflection'

/** Slug of the flag gating per-org BYOK LLM credentials (ADR-0022). */
export const BYOK_LLM_FLAG = 'byok-llm'

/**
 * Slug of the flag gating the Workflows feature (ADR-0023). Session paths use
 * `isWorkflowsEnabled` (authz/feature-flags); the session-less scheduled-fire
 * path evaluates this slug per-org so revoking an org's flag also pauses its
 * schedules (fail-closed, like memory-reflection).
 */
export const WORKFLOWS_FLAG = 'workflows'

/**
 * Slug of the platform-layer web-search flag (ADR-0022). Participates only
 * when GRID_ENFORCE_FEATURE_FLAGS=true — see `isWebSearchEnabledForOrg` in
 * `@/lib/organizations/service`, which combines it with the tenant's own
 * `settings.webSearchEnabled` toggle.
 */
export const WEB_SEARCH_FLAG = 'web-search'

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

/**
 * Whether the async post-answer memory-reflection stage runs for this org.
 *
 * With WorkOS flag enforcement on (GRID_ENFORCE_FEATURE_FLAGS=true) the
 * per-org `memory-reflection` flag is the source of truth (fail-closed).
 * Without enforcement the stage follows GRID_MEMORY_REFLECTION_ENABLED and
 * defaults ON — memory reflection is a shipped core capability, not a
 * dark-launched product gate, so it stays available in environments without
 * the flag product like every non-dark feature. The backend still no-ops
 * when no `memory_reflection_llm` is configured (the capability bit).
 */
export async function isMemoryReflectionEnabled(
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (enforcementOn()) {
    return isOrgFeatureEnabled(MEMORY_REFLECTION_FLAG, organizationId)
  }
  return (process.env.GRID_MEMORY_REFLECTION_ENABLED ?? 'true').toLowerCase() !== 'false'
}

/** Test hook: clear a specific org's flag cache entry. */
export async function _clearFeatureFlagCache(organizationId?: string): Promise<void> {
  if (organizationId) {
    await invalidateCached(`flags:${organizationId}`)
  }
}
