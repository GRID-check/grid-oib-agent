import { findProjectProfile, findProjectPromptView } from '@/lib/projects/repository'
import { getCached, invalidateCached } from '@/lib/cache'
import { buildProjectBriefView } from './brief-view'
import { isValidBundeslandToken } from './intake-definition'
import { ProjectProfileSchema } from './types'
import type { ProjectPrimitiveValue, ProjectProfile, ProjectProfileDisplay } from './types'

// Re-exported so existing server-side importers (profile / patches routes, tests)
// keep a single import surface; the engine itself now lives in the isomorphic
// patch-engine module so the intake wizard can share it.
export { applyProjectProfilePatch, emptyProjectProfile } from './patch-engine'

const PROMPT_VIEW_CACHE_TTL_MS = 5 * 60 * 1000

/** Key segment for a request that legitimately has no organization. */
const ANONYMOUS_TENANT = 'anon'

/**
 * Cache keys derived from the stored profile (`projects.profile`). BOTH are
 * served with the same 5-min TTL and MUST be invalidated together on every
 * profile write — see {@link invalidateProjectProfileCaches}.
 *
 * The organization is part of the key, and that is a tenancy boundary rather
 * than a nicety. `getCached` returns BEFORE the loader runs, so a key of
 * `projectId` alone meant a hit served whatever the first caller had populated
 * — without ever entering the tenant scope or consulting row-level security.
 * The project id is supplied by the caller on the websocket-scope path, so an
 * id belonging to another organization would have returned that organization's
 * project context straight out of the cache. Partitioning by tenant is what
 * makes the cached path obey the same boundary as the query behind it.
 */
const promptViewCacheKey = (projectId: string, organizationId: string | null | undefined) =>
  `promptview:${organizationId ?? ANONYMOUS_TENANT}:${projectId}`
const bundeslandCacheKey = (projectId: string, organizationId: string | null | undefined) =>
  `bundesland:${organizationId ?? ANONYMOUS_TENANT}:${projectId}`

/**
 * Cached read of the project-context prompt view injected into the agent on
 * every WS upgrade. Backed by the shared cache (ADR-0020), so a profile edit
 * on one replica invalidates for all replicas — the per-process Map this
 * replaces served stale project context for up to 5 minutes after an edit.
 */
export async function loadProjectPromptView(
  projectId: string | undefined,
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!projectId) return null

  return getCached(
    promptViewCacheKey(projectId, organizationId),
    PROMPT_VIEW_CACHE_TTL_MS,
    async () => {
      const promptView = (await findProjectPromptView(projectId, organizationId))?.trim()
      return promptView || null
    }
  )
}

export async function invalidateProjectPromptViewCache(
  projectId: string,
  organizationId: string | null | undefined
): Promise<void> {
  await Promise.all(
    tenantVariants(promptViewCacheKey, projectId, organizationId).map((key) =>
      invalidateCached(key)
    )
  )
}

/**
 * Every tenant-partitioned key a project's cached value can live under.
 *
 * A write must drop the anonymous variant as well as its own: an anonymous
 * deployment populates `anon` while an authenticated write knows an
 * organization, and dropping only one leaves the other serving the value the
 * write just replaced.
 */
function tenantVariants(
  key: (projectId: string, organizationId: string | null | undefined) => string,
  projectId: string,
  organizationId: string | null | undefined
): string[] {
  const keys = new Set([key(projectId, organizationId), key(projectId, null)])
  return [...keys]
}

/**
 * Invalidate EVERY per-project cache derived from the stored profile. Both the
 * prompt-view text (`promptview:`) and the structured `bundesland` fact
 * (`bundesland:`) are read from `projects.profile` with a 5-min TTL, so a
 * profile write must drop BOTH keys — otherwise a wizard save that changes the
 * location leaves the jurisdiction-dependent `bundesland` on the WS handshake
 * (RIS logic) stale for up to 5 minutes. This is the single invalidation every
 * profile write path (`saveProjectProfile`, `patchProjectProfile`) must call.
 */
export async function invalidateProjectProfileCaches(
  projectId: string,
  organizationId: string | null | undefined
): Promise<void> {
  await Promise.all(
    [
      ...tenantVariants(promptViewCacheKey, projectId, organizationId),
      ...tenantVariants(bundeslandCacheKey, projectId, organizationId),
    ].map((key) => invalidateCached(key))
  )
}

/**
 * Cached read of the project's validated `bundesland` fact, straight off the
 * stored structured profile (`projects.profile.facts.bundesland.value`) —
 * the SAME source `buildProjectPromptView` reads to emit the
 * `bundesland=<token>` text line `loadProjectPromptView` above serves.
 *
 * Backlog T3-9 follow-up (2026-07-16, user-mandated): jurisdiction is a
 * cross-cutting request fact and must travel STRUCTURED on the
 * `X-Grid-Request-Context` envelope, not be re-parsed out of that prompt
 * text — this is the read producers resolve `GridRequestContextInput.bundesland`
 * from. Returns `null` for no project, no fact, or a value outside the
 * validated intake vocabulary (a stale/corrupt row must never leak an
 * unvalidated token onto the wire).
 */
export async function loadProjectBundesland(
  projectId: string | undefined,
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!projectId) return null

  return getCached(
    bundeslandCacheKey(projectId, organizationId),
    PROMPT_VIEW_CACHE_TTL_MS,
    async () => {
      const profile = await findProjectProfile(projectId, organizationId)
      const value = profile?.facts?.bundesland?.value
      return typeof value === 'string' && isValidBundeslandToken(value) ? value : null
    }
  )
}

export function buildProjectPromptView(profile: ProjectProfile): string {
  const normalized = ProjectProfileSchema.parse(profile)
  const sections: string[][] = [['PROJECT_CONTEXT v1']]

  const factKeys = Object.keys(normalized.facts).sort()

  // Legacy profile: no country fact but valid AT bundesland → derive country=at
  const countryInFacts = normalized.facts.country
  if (!countryInFacts && normalized.facts.bundesland?.value) {
    const bv = normalized.facts.bundesland.value
    if (typeof bv === 'string' && bv !== 'ausserhalb_oesterreichs' && isValidBundeslandToken(bv)) {
      factKeys.unshift('country')
      normalized.facts.country = {
        value: 'at',
        confidence: 'confirmed',
        source: 'onboarding',
        updatedAt: '',
      }
    }
  }

  if (factKeys.length > 0) {
    sections.push([
      'confirmed:',
      ...factKeys.map(
        (key) => `- ${formatPromptToken(key)}=${formatPromptValue(normalized.facts[key].value)}`
      ),
    ])
  }

  const goalKeys = Object.keys(normalized.goals).sort()
  if (goalKeys.length > 0) {
    sections.push([
      'goals:',
      ...goalKeys.map(
        (key) => `- ${formatPromptToken(key)}=${formatPromptValue(normalized.goals[key])}`
      ),
    ])
  }

  const unknowns = [...normalized.unknowns].sort()
  if (unknowns.length > 0) {
    sections.push(['unknown:', ...unknowns.map((unknown) => `- ${formatPromptToken(unknown)}`)])
  }

  const assumptionKeys = Object.keys(normalized.assumptions).sort()
  if (assumptionKeys.length > 0) {
    sections.push([
      'assumptions:',
      ...assumptionKeys.map(
        (key) =>
          `- ${formatPromptToken(key)}=${formatPromptValue(normalized.assumptions[key].value)}`
      ),
    ])
  }

  return sections.map((section) => section.join('\n')).join('\n\n')
}

export function buildProjectProfileDisplay(
  profile: ProjectProfile,
  // The AI summary is generated by a separate async call (POST /generate-summary)
  // and stored on profileDisplay.summary. Rebuilding the display from the raw
  // profile (on every save/patch) must PRESERVE that summary rather than wiping
  // it -- otherwise any chat-driven profile edit permanently blanks the Project
  // Brief prose until the next full intake save.
  previousSummary = '',
  // The locale that `previousSummary` was generated in, carried over 1:1 with
  // the summary so a preserved prose keeps its language provenance (and a reset
  // summary drops it — callers pass undefined). See ProjectProfileDisplaySchema.
  previousSummaryLocale?: string
): ProjectProfileDisplay {
  const normalized = ProjectProfileSchema.parse(profile)
  const brief = buildProjectBriefView(normalized)

  return {
    title: 'Project profile',
    summary: previousSummary,
    summaryLocale: previousSummaryLocale,
    // Human-readable, intake-ordered: question labels ("Building class") and
    // option labels ("Residential") instead of raw keys/enum values.
    keyFacts: brief.groups.flatMap((group) =>
      group.facts.map((fact) => ({ label: fact.label, value: fact.value }))
    ),
    missingInfo: brief.missing.map((item) => item.label),
  }
}

function formatPromptToken(value: string): string {
  return isSafePromptToken(value)
    ? value
    : JSON.stringify(value).replace(/[\u0080-\u009f\u2028\u2029]/g, escapeLineSeparator)
}

function formatPromptValue(value: ProjectPrimitiveValue): string {
  if (typeof value === 'string') {
    return formatPromptToken(value)
  }

  return String(value)
}

function isSafePromptToken(value: string): boolean {
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
}

function escapeLineSeparator(value: string): string {
  return `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`
}
