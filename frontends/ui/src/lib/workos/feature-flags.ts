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
import {
  FEATURE_FLAGS,
  enforcementOn,
  projectMailInboxEnvEnabled,
  type FeatureFlagSlug,
} from '@/lib/authz/feature-flags'
import { TransientAuthzError } from '@/lib/authz/errors'

/** Slug of the flag gating the async post-answer memory-reflection stage. */
export const MEMORY_REFLECTION_FLAG = FEATURE_FLAGS.memoryReflection

/**
 * Slug of the flag gating the async post-answer follow-up-questions stage.
 * The stage delivers a `grid_stage_message` frame that renders as a rail below
 * the answer; it ran `silent` for one slice first so its skip rate, empty rate
 * and true per-turn cost were measured before any reader saw a chip
 * (docs/architecture/post-answer-stages.md §10, slices 1 and 3).
 */
export const FOLLOW_UPS_FLAG = FEATURE_FLAGS.postAnswerFollowUps

/** Slug of the flag gating per-org BYOK LLM credentials (ADR-0022). */
export const BYOK_LLM_FLAG = FEATURE_FLAGS.byokLlm

/**
 * Slug of the flag gating the Agent Skills feature (Phase A). Session paths
 * use `isSkillsEnabled` (authz/feature-flags); the session-less scheduled-fire
 * path evaluates this slug per-org so revoking an org's flag also pauses its
 * skill schedules (fail-closed).
 */
export const SKILLS_FLAG = FEATURE_FLAGS.skills

/**
 * Slug of the platform-layer web-search flag (ADR-0022). Participates only
 * when GRID_ENFORCE_FEATURE_FLAGS=true — see `isWebSearchEnabledForOrg` in
 * `@/lib/organizations/service`, which combines it with the tenant's own
 * `settings.webSearchEnabled` toggle.
 */
export const WEB_SEARCH_FLAG = FEATURE_FLAGS.webSearch

/**
 * Slug of the flag gating deep research. Taken from the registry rather than
 * re-spelled, because this one is now read on TWO paths that must agree: the
 * session gate on `POST /api/jobs/async/submit`, and the session-less per-turn
 * read below that tells the agent tier whether it may offer the run at all.
 */
export const DEEP_RESEARCH_FLAG = FEATURE_FLAGS.deepResearch

/**
 * Slug of the flag gating delegated tasks and schedules. Read session-lessly
 * for the same reason as the one above: the agent's `create_task` reaches the
 * BFF with a signed envelope, not a session, and the model has to be told
 * before it offers the hand-off.
 */
export const TASK_AUTOMATION_FLAG = FEATURE_FLAGS.taskAutomation

const CACHE_TTL_MS = 30_000

/**
 * Every flag slug enabled for `organizationId`, read from WorkOS (cached 30s
 * per org). The full-set reader: a caller that needs more than one flag, such
 * as a session built for somebody who is not signed in, reads them all in one
 * call instead of asking flag by flag.
 *
 * THROWS when WorkOS cannot be asked (no API key, network, plan). It does not
 * decide what a failure means; {@link isOrgFeatureEnabled} fails closed, an
 * unattended caller may retry.
 */
export async function enabledSlugsForOrg(organizationId: string): Promise<Set<string>> {
  if (!process.env.WORKOS_API_KEY) {
    throw new Error('WORKOS_API_KEY is not set; organization flags cannot be read')
  }
  const slugs = await getCached(`flags:${organizationId}`, CACHE_TTL_MS, async () => {
    const list = await getWorkOS().featureFlags.listOrganizationFeatureFlags({ organizationId })
    // EVERY page, not the first. The endpoint defaults to 10 flags and this
    // reader treats "absent from the set" as "off", so a one-page read silently
    // disables whatever sorts past the tenth — which is not a hypothetical: an
    // organization here is served more than ten. `autoPagination` follows the
    // cursor for us, and deliberately gets NO `limit`: the SDK short-circuits to
    // the first page when the first request carried one.
    const flags = await list.autoPagination()
    return flags.map((flag) => flag.slug)
  })
  return new Set(slugs)
}

/**
 * Whether `slug` is enabled for `organizationId`. Returns `defaultValue` when
 * there is no org, no WorkOS API key, or evaluation fails (fail-closed).
 */
export async function isOrgFeatureEnabled(
  slug: FeatureFlagSlug,
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
  readonly flag: FeatureFlagSlug
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
    // ON. It shipped OFF, as every new stage does, and was switched on per org
    // while the empty rate and the per-turn cost were read off the
    // `stage:follow_ups` spans. It is ON for every organization in both WorkOS
    // environments now, and the in-answer `follow_ups` CARD it replaces has been
    // deleted (ADR-0069), so this stage is the only thing that
    // produces follow-up questions at all.
    //
    // That is what moves the default: `defaultOn` is what a deployment without
    // the flag product sees, and leaving it false there would mean a Grid with
    // no follow-ups anywhere and nothing to switch on. It is a shipped core
    // capability now, on the same footing as `memory_reflection` — including the
    // capability bit, so a workflow config with no `follow_ups_llm` is still a
    // no-op rather than a failure.
    //
    // Turning the WorkOS flag off still stops the frames within a turn or two,
    // no deploy and no reconnect, and the answer is unaffected either way. What
    // it no longer does is fall back to the card: the card type no longer
    // exists, so reversing that means restoring it (ADR-0069).
    defaultOn: true,
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

/**
 * Whether deep research is available to this org, resolved WITHOUT a session.
 *
 * The session-bearing half of this decision is `requireFeature(session,
 * FEATURE_FLAGS.deepResearch)` on `POST /api/jobs/async/submit`, which refuses
 * the job. That gate is necessary and was never sufficient: it closes the queue
 * and nothing upstream of it knows the flag, so the agent still escalated, the
 * clarifier still put a plan in front of the reader, and the approval button
 * answered 403. This is what the agent tier reads per turn (`GET
 * /api/internal/stages`) so it can decline to OFFER the run.
 *
 * Fail-open with enforcement off, exactly like `isFeatureEnabled`: the two
 * halves must reach the same verdict, and a deployment that does not enforce
 * flags has deep research for everyone.
 */
export async function isDeepResearchEnabledForOrg(
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (!enforcementOn()) return true
  // No organization is not a tenant with the flag switched off: it is an
  // anonymous deployment (REQUIRE_AUTH=false) or a break-glass session, and
  // `POST /api/jobs/async/submit` skips its own gate for exactly that case.
  // Denying here would make the two halves disagree and withdraw deep research
  // from a deployment that has no per-org flags to read in the first place.
  if (!organizationId) return true
  return isOrgFeatureEnabled(DEEP_RESEARCH_FLAG, organizationId)
}

/**
 * Whether this org may create delegated tasks and schedules, WITHOUT a session.
 *
 * Same two-halves shape as {@link isDeepResearchEnabledForOrg}, and the same
 * reason for each half: the agent tier reads this per turn so it can decline to
 * OFFER a hand-off, and `POST /api/internal/tasks` re-reads it so a turn that
 * offers one anyway still creates nothing.
 */
export async function isTaskAutomationEnabledForOrg(
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (!enforcementOn()) return true
  // See `isDeepResearchEnabledForOrg`: no organization is an anonymous or
  // break-glass caller, not a tenant with the flag switched off.
  if (!organizationId) return true
  return isOrgFeatureEnabled(TASK_AUTOMATION_FLAG, organizationId)
}

/**
 * Whether the project email address is on for this org, WITHOUT a session: the
 * webhook and the drain act for an organization, not a signed-in person.
 *
 * The same two halves as `isProjectMailInboxEnabled` (authz/feature-flags):
 * enforcement on reads the per-org flag, enforcement off reads the opt-in env
 * variable. No organization is off: unlike deep research, nothing here serves
 * an anonymous deployment.
 *
 * A flag read that could not complete THROWS {@link TransientAuthzError}
 * rather than answering `false`. "Off" is a permanent refusal to the sender's
 * server; "could not ask" must be a retry (review finding C2).
 */
export async function isProjectMailInboxEnabledForOrg(
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (!organizationId) return false
  if (!enforcementOn()) return projectMailInboxEnvEnabled()
  try {
    return (await enabledSlugsForOrg(organizationId)).has(FEATURE_FLAGS.projectMailInbox)
  } catch (error) {
    throw new TransientAuthzError('feature-flags', { cause: error })
  }
}

/** Test hook: clear a specific org's flag cache entry. */
export async function _clearFeatureFlagCache(organizationId?: string): Promise<void> {
  if (organizationId) {
    await invalidateCached(`flags:${organizationId}`)
  }
}
