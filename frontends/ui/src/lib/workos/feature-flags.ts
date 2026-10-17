/**
 * WorkOS feature-flag evaluation (server-side, without a session).
 *
 * `listOrganizationFeatureFlags` returns the flags **enabled** for an
 * organization, so membership of a slug == "on for this org". Results are cached
 * briefly per org to avoid a WorkOS round-trip on every WebSocket upgrade.
 *
 * The same rules as the session gates in `lib/authz/feature-flags.ts`, whose
 * header is the argument: fail-closed on any error (no API key, feature not on
 * the plan, network) and for a caller with no organization, and the fixed
 * per-kind answer in a deployment that authenticates nobody. A flag outage
 * never silently enables a gated capability.
 */

import { getWorkOS } from './client'
import { getCached, invalidateCached } from '@/lib/cache'
import {
  FEATURE_FLAGS,
  flagsFromWorkOS,
  unauthenticatedDefault,
  type KnownFeatureFlag,
} from '@/lib/authz/feature-flags'
import { TransientAuthzError, type AuthzLookupOptions } from '@/lib/authz/errors'

const CACHE_TTL_MS = 30_000

async function enabledSlugsForOrg(organizationId: string): Promise<Set<string>> {
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
 * Every flag enabled for `organizationId`, for a session built without a token
 * (`lib/auth/pinned-session.ts`): the set a live session's JWT claim would
 * carry.
 *
 * A failed lookup THROWS rather than answering "none". Its callers are
 * background work acting for a person, and "none" is not a refusal there but a
 * silent wrong answer that sticks: the mail import would file every picture as
 * "file type not accepted" (the `image-upload` gate) for as long as WorkOS was
 * down, while a throw has the job retry once it is back.
 */
export async function enabledFlagsForOrganization(organizationId: string): Promise<string[]> {
  if (!process.env.WORKOS_API_KEY) return []
  return [...(await enabledSlugsForOrg(organizationId))]
}

/**
 * Whether `flag` is enabled for `organizationId`, for a caller without a
 * session. OFF when there is no organization, no WorkOS API key, or the lookup
 * fails; the fixed per-kind answer where nobody authenticates.
 *
 * With `onError: 'throw'`, a lookup that could not complete (no WorkOS key,
 * network, plan) throws {@link TransientAuthzError} instead of answering OFF:
 * for a caller to whom "off" is a permanent answer, "could not ask" has to be
 * a retry.
 */
export async function isOrgFeatureEnabled(
  flag: KnownFeatureFlag,
  organizationId: string | null | undefined,
  options: AuthzLookupOptions = {},
): Promise<boolean> {
  if (!flagsFromWorkOS()) return unauthenticatedDefault(flag)
  if (!organizationId) return false
  const throwOnError = options.onError === 'throw'
  if (!process.env.WORKOS_API_KEY) {
    if (!throwOnError) return false
    throw new TransientAuthzError('feature-flags', {
      cause: new Error('WORKOS_API_KEY is not set; organization flags cannot be read'),
    })
  }
  try {
    return (await enabledSlugsForOrg(organizationId)).has(flag)
  } catch (error) {
    if (throwOnError) throw new TransientAuthzError('feature-flags', { cause: error })
    console.warn(`[FeatureFlags] evaluation of "${flag}" failed; treating it as off`, error)
    return false
  }
}

/**
 * One post-answer stage's runtime switch (see
 * `docs/architecture/post-answer-stages.md` §7.8). The `id` mirrors the
 * `StageSpec.id` declared in `src/aiq_agent/stages/`; `flag` mirrors its
 * `flag_slug` (`tests/aiq_agent/stages/test_stage_flag_parity.py`). Keep the
 * two sides in step — a stage the backend declares but this registry omits can
 * never be switched on.
 */
export interface PostAnswerStageFlag {
  readonly id: string
  readonly flag: KnownFeatureFlag
}

export const POST_ANSWER_STAGE_FLAGS: readonly PostAnswerStageFlag[] = [
  {
    id: 'memory_reflection',
    flag: 'memory-reflection',
  },
  {
    // ON for every organization in both WorkOS environments, and the only thing
    // that produces follow-up questions since the in-answer `follow_ups` CARD
    // was deleted (ADR-0069). Turning the flag off stops the frames within a
    // turn or two, no deploy and no reconnect; it does not bring the card back.
    id: 'follow_ups',
    flag: 'post-answer-follow-ups',
  },
]

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
      (await isOrgFeatureEnabled(stage.flag, organizationId)) ? stage.id : null,
    ),
  )
  return decisions.filter((id): id is string => id !== null)
}

/**
 * Whether the async post-answer memory-reflection stage runs for this org.
 * Retained as the name the WebSocket-upgrade path uses.
 */
export async function isMemoryReflectionEnabled(
  organizationId: string | null | undefined,
): Promise<boolean> {
  return isOrgFeatureEnabled(FEATURE_FLAGS.memoryReflection, organizationId)
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
 * The same verdict the session gate reaches: OFF for a caller with no
 * organization. That case used to answer ON, on the reasoning that an
 * org-less caller is an anonymous deployment or a break-glass session rather
 * than a tenant with the flag switched off — which made the one entitlement
 * that costs the most the one that failed open. An anonymous deployment gets
 * its answer from `flagsFromWorkOS` instead (deep research is an entitlement,
 * so off), and a break-glass session has no tenant to bill a run to.
 */
export async function isDeepResearchEnabledForOrg(
  organizationId: string | null | undefined,
): Promise<boolean> {
  return isOrgFeatureEnabled(FEATURE_FLAGS.deepResearch, organizationId)
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
  return isOrgFeatureEnabled(FEATURE_FLAGS.taskAutomation, organizationId)
}

/**
 * Whether the project email address is on for this org, WITHOUT a session: the
 * webhook and the filing job act for an organization, not a signed-in person.
 *
 * The same answer as `isProjectMailInboxEnabled` in `lib/authz/feature-flags`,
 * except that a lookup that could not complete THROWS
 * {@link TransientAuthzError}: here "off" is a permanent refusal to the
 * sender's server, so "could not ask" has to be a retry.
 */
export async function isProjectMailInboxEnabledForOrg(
  organizationId: string | null | undefined,
): Promise<boolean> {
  return isOrgFeatureEnabled(FEATURE_FLAGS.projectMailInbox, organizationId, { onError: 'throw' })
}

/** Test hook: clear a specific org's flag cache entry. */
export async function _clearFeatureFlagCache(organizationId?: string): Promise<void> {
  if (organizationId) {
    await invalidateCached(`flags:${organizationId}`)
  }
}
