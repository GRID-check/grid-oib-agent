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

/**
 * Slug of the flag gating the async post-answer follow-up-questions stage.
 * The stage delivers a `grid_stage_message` frame that renders as a rail below
 * the answer; it ran `silent` for one slice first so its skip rate, empty rate
 * and true per-turn cost were measured before any reader saw a chip
 * (docs/architecture/post-answer-stages.md §10, slices 1 and 3).
 */
export const FOLLOW_UPS_FLAG = 'post-answer-follow-ups'

/** Slug of the flag gating per-org BYOK LLM credentials (ADR-0022). */
export const BYOK_LLM_FLAG = 'byok-llm'

/**
 * Slug of the flag gating the Agent Skills feature (Phase A). Session paths
 * use `isSkillsEnabled` (authz/feature-flags); the session-less scheduled-fire
 * path evaluates this slug per-org so revoking an org's flag also pauses its
 * skill schedules (fail-closed).
 */
export const SKILLS_FLAG = 'skills'

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
 * One post-answer stage's runtime switch (see
 * `docs/architecture/post-answer-stages.md` §7.8). The `id` mirrors the
 * `StageSpec.id` declared in `src/aiq_agent/stages/`; `flag` and `envVar`
 * mirror its `flag_slug` and `env_default`. Keep the two sides in step — a
 * stage the backend declares but this registry omits can never be switched on.
 */
export interface PostAnswerStageFlag {
  readonly id: string
  readonly flag: string
  readonly envVar: string
  /** The value when flag enforcement is off and the env var is unset. */
  readonly defaultOn: boolean
}

export const POST_ANSWER_STAGE_FLAGS: readonly PostAnswerStageFlag[] = [
  {
    id: 'memory_reflection',
    flag: MEMORY_REFLECTION_FLAG,
    envVar: 'GRID_MEMORY_REFLECTION_ENABLED',
    // Memory reflection is a shipped core capability, not a dark-launched
    // product gate, so like every non-dark feature it stays ON in environments
    // without the flag product. New stages default OFF.
    defaultOn: true,
  },
  {
    id: 'follow_ups',
    flag: FOLLOW_UPS_FLAG,
    envVar: 'GRID_STAGE_FOLLOW_UPS_ENABLED',
    // OFF, as every new stage is: it costs an LLM call per substantive answer.
    // It is switched on per org — one, for now — and off again without a
    // deploy, which is the whole of this feature's rollback story.
    defaultOn: false,
  },
]

/**
 * Whether one post-answer stage runs for this org.
 *
 * With WorkOS flag enforcement on (GRID_ENFORCE_FEATURE_FLAGS=true) the
 * per-org flag is the source of truth (fail-closed). Without enforcement the
 * stage follows its env var. The backend still no-ops when no LLM is
 * configured for the stage's agent group (the capability bit).
 */
export async function isPostAnswerStageEnabled(
  stage: PostAnswerStageFlag,
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (enforcementOn()) {
    return isOrgFeatureEnabled(stage.flag, organizationId)
  }
  return (process.env[stage.envVar] ?? String(stage.defaultOn)).toLowerCase() !== 'false'
}

/**
 * The ids of every post-answer stage switched on for this org.
 *
 * Served per TURN (`GET /api/internal/stages`), not per socket upgrade: the
 * upgrade-time evaluation could not reach an already-open tab, so an operator
 * reaching for the kill switch did not actually switch anything off until every
 * reader reconnected. A 30s flag cache sits underneath, so the per-turn cost is
 * a map lookup rather than a WorkOS round-trip.
 */
export async function enabledPostAnswerStages(
  organizationId: string | null | undefined,
): Promise<string[]> {
  const decisions = await Promise.all(
    POST_ANSWER_STAGE_FLAGS.map(async (stage) =>
      (await isPostAnswerStageEnabled(stage, organizationId)) ? stage.id : null,
    ),
  )
  return decisions.filter((id): id is string => id !== null)
}

/**
 * Whether the async post-answer memory-reflection stage runs for this org.
 *
 * Retained as the name the WebSocket-upgrade path uses; it now delegates to the
 * stage registry above so there is one source of truth for the decision.
 */
export async function isMemoryReflectionEnabled(
  organizationId: string | null | undefined,
): Promise<boolean> {
  const stage = POST_ANSWER_STAGE_FLAGS.find((entry) => entry.flag === MEMORY_REFLECTION_FLAG)
  if (!stage) return false
  return isPostAnswerStageEnabled(stage, organizationId)
}

/** Test hook: clear a specific org's flag cache entry. */
export async function _clearFeatureFlagCache(organizationId?: string): Promise<void> {
  if (organizationId) {
    await invalidateCached(`flags:${organizationId}`)
  }
}
