/**
 * Project profile service — business logic for the structured project
 * profile: optimistic-concurrency reads/writes, agent patch application, the
 * intake definition, and AI summary generation.
 *
 * Owns authorization (`requireProjectAccess`) and orchestrates the projects
 * repository, the prompt/display view builders, and the Python backend.
 * Failures are signalled with typed errors from `@/lib/api/errors`; version
 * conflicts on the optimistic profile write surface as 409 `ConflictError`s.
 */

import 'server-only'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getBackendUrl } from '@/lib/backend-proxy'
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  findProjectProfileInOrg,
  setProjectProfileSummaryInOrg,
  updateProjectProfileIfVersion,
  type ProjectProfileState,
} from '@/lib/projects/repository'
import {
  applyProjectProfilePatch,
  buildProjectProfileDisplay,
  buildProjectPromptView,
  invalidateProjectProfileCaches,
} from './prompt-view'
import { buildProjectSummaryText } from './brief-view'
import {
  isPatchAlreadyApplied,
  normalizeProfilePatchOperations,
  pruneResolvedAssumptions,
  pruneResolvedUnknowns,
} from './patch-engine'
import {
  projectIntakeDefinitionV1,
  validateProfilePatchVocabulary,
  type ProjectIntakeDefinition,
} from './intake-definition'
import type { AiConsistencyFinding, ConsistencyCheckField } from './intake-consistency'
import type { ProjectProfile, ProjectProfilePatchOperation } from './types'

/**
 * Server-side backend fetches MUST be time-bounded: an unreachable backend
 * container (inter-container network flakiness) otherwise hangs the request
 * past Cloudflare's ~100s origin timeout and surfaces as a 504. The consistency
 * check is a fail-open pre-save enrichment (short bound); summary generation is
 * a user-visible LLM call (longer bound).
 */
const CONSISTENCY_CHECK_TIMEOUT_MS = 10_000
/**
 * MUST stay above the backend's own LLM timeout (30s in generate_summary.py):
 * with the bounds inverted the BFF aborts first, the backend finishes the
 * generation anyway, and the completed summary is thrown away because
 * persistence happens here after the response. Still well under Cloudflare's
 * ~100s origin timeout.
 */
const GENERATE_SUMMARY_TIMEOUT_MS = 35_000

export async function getProjectProfile(
  session: AuthorizedSession,
  projectId: string,
): Promise<ProjectProfileState> {
  await requireProjectAccess(session, projectId, 'project:view')
  const state = await findProjectProfileInOrg(projectId, session.organizationId)
  if (!state) throw new NotFoundError()
  return state
}

/**
 * Replace the whole profile (intake wizard save). 409 on a version conflict.
 *
 * `expectedVersion` is the profileVersion the CLIENT loaded (sent as If-Match):
 * comparing against it is what makes the concurrency check real — without it
 * the version is read and compared inside this one request, so edits made by
 * someone else since the wizard was opened are silently last-writer-wins.
 *
 * A full replace also resets the stored AI summary: the prose described the old
 * profile, and the overview regenerates it from the new one.
 */
export async function saveProjectProfile(
  session: AuthorizedSession,
  projectId: string,
  profile: ProjectProfile,
  expectedVersion?: number,
): Promise<ProjectProfileState> {
  await requireProjectAccess(session, projectId, 'project:edit')
  const current = await findProjectProfileInOrg(projectId, session.organizationId)
  if (!current) throw new NotFoundError()
  if (expectedVersion !== undefined && current.profileVersion !== expectedVersion) {
    throw new ConflictError('Conflict: profile was modified since it was loaded')
  }
  return persistProfile(projectId, session.organizationId, profile, current, { resetSummary: true })
}

/** A patch write, plus whether it landed or was already there. */
export interface PatchedProjectProfile extends ProjectProfileState {
  /**
   * The write lost an optimistic-lock race to a request that had ALREADY applied
   * these exact operations (two collaborators accepting the same card). The
   * profile holds the change, so this is an idempotent success rather than the
   * generic 409 — which the caller must keep treating as "your patch did not land".
   */
  alreadyApplied?: boolean
}

/**
 * Apply agent-proposed patch operations to the stored profile. Bare values
 * are wrapped with provenance (accepting the card is the user confirmation),
 * then any unknowns the patch just answered are retired. 409 on a version
 * conflict, unless the conflict is the concurrent-accept case above.
 */
export async function patchProjectProfile(
  session: AuthorizedSession,
  projectId: string,
  operations: ProjectProfilePatchOperation[],
): Promise<PatchedProjectProfile> {
  await requireProjectAccess(session, projectId, 'project:edit')
  const current = await findProjectProfileInOrg(projectId, session.organizationId)
  if (!current) throw new NotFoundError()

  let normalized: ProjectProfilePatchOperation[]
  let profile: ProjectProfile
  try {
    // Defense-in-depth: reject values that violate the intake vocabulary before
    // they are wrapped with `user_confirmed` provenance and persisted.
    validateProfilePatchVocabulary(operations)
    normalized = normalizeProfilePatchOperations(operations)
    profile = pruneResolvedUnknowns(applyProjectProfilePatch(current.profile, normalized))
  } catch (error) {
    throw new BadRequestError(
      error instanceof Error ? error.message : 'Invalid project profile patch.',
    )
  }

  try {
    return await persistProfile(projectId, session.organizationId, profile, current)
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error
    // Somebody wrote between our read and our write. `updateProjectProfileIfVersion`
    // only compares `profileVersion`, so a 409 alone says nothing about WHOSE change
    // won — read the winner's profile and ask whether it already contains ours. Only
    // then is the outcome a success; anything else is a conflict the caller must see
    // and be able to retry, or a patch is reported as applied while it was dropped.
    const fresh = await findProjectProfileInOrg(projectId, session.organizationId)
    if (!fresh || !isPatchAlreadyApplied(fresh.profile, normalized)) throw error
    return { ...fresh, alreadyApplied: true }
  }
}

/**
 * Optimistic-concurrency write shared by save and patch: rebuild the derived
 * prompt/display views (preserving the async-generated summary), bump the
 * version, and refuse the write when a concurrent request got there first.
 */
async function persistProfile(
  projectId: string,
  organizationId: string,
  rawProfile: ProjectProfile,
  current: ProjectProfileState,
  options?: {
    /**
     * Wizard full-replace: clear the stored AI summary instead of carrying it
     * over — the prose described the profile being replaced. Patch-driven
     * edits keep preserving it (regenerating on every chat patch would churn).
     */
    resetSummary?: boolean
  },
): Promise<ProjectProfileState> {
  // Single choke point for BOTH the wizard save and agent patches: a confirmed
  // fact always retires an unconfirmed assumption under the same key (e.g. the
  // migration-backfilled `bundesland=wien` default once the user answers the
  // location question).
  const profile = pruneResolvedAssumptions(rawProfile)
  const updated = await updateProjectProfileIfVersion(projectId, organizationId, current.profileVersion, {
    profile,
    profileVersion: current.profileVersion + 1,
    profilePromptView: buildProjectPromptView(profile),
    profileDisplay: buildProjectProfileDisplay(
      profile,
      options?.resetSummary ? '' : current.profileDisplay?.summary ?? '',
      // The locale travels with the summary: a wizard full-replace resets both
      // (the new prose will record its own locale when regenerated); a patch
      // preserves both so a chat edit never drops the language provenance.
      options?.resetSummary ? undefined : current.profileDisplay?.summaryLocale,
    ),
    profileUpdatedAt: new Date(),
  })
  if (!updated) throw new ConflictError('Conflict: profile was modified by another request')

  // Drop BOTH profile-derived caches (prompt-view AND bundesland): a location
  // change must not leave a stale jurisdiction on the WS handshake for up to
  // the 5-min TTL. This is the single choke point for the wizard save and agent
  // patches, so both write paths are covered here.
  await invalidateProjectProfileCaches(projectId, organizationId)
  return updated
}

/** The static intake questionnaire definition (gated on project visibility). */
export async function getProjectIntakeDefinition(
  session: AuthorizedSession,
  projectId: string,
): Promise<ProjectIntakeDefinition> {
  await requireProjectAccess(session, projectId, 'project:view')
  return projectIntakeDefinitionV1
}

/** The raw finding shape the Python backend returns (prose, not i18n keys). */
interface BackendConsistencyFinding {
  fields?: unknown
  severity?: unknown
  explanation?: unknown
}

/** Normalise a backend finding into an {@link AiConsistencyFinding}, or drop it. */
function toAiFinding(raw: BackendConsistencyFinding): AiConsistencyFinding | null {
  const message = typeof raw.explanation === 'string' ? raw.explanation.trim() : ''
  if (!message) return null
  const severity: AiConsistencyFinding['severity'] =
    raw.severity === 'inconsistency' ? 'inconsistency' : 'warning'
  const fields = Array.isArray(raw.fields) ? raw.fields.filter((f): f is string => typeof f === 'string') : []
  return { kind: 'ai', fields, severity, message }
}

/**
 * End-of-wizard FREE-TEXT consistency check (FB-13): ask the Python backend's
 * LLM whether the free-text answers contradict the structured answers (or each
 * other), BEFORE the profile is saved. Structured answers are checked
 * deterministically on the client (`intake-consistency.ts`) and passed here only
 * as read-only context.
 *
 * Fully fail-open: this never throws and always resolves to a result the wizard
 * can act on. Any backend transport failure or non-200 degrades to
 * `{ findings: null, error }` (the wizard then saves anyway) — an infrastructure
 * problem must never block the user from saving. `findings: []` means the free
 * text is consistent.
 */
export async function checkProjectConsistency(
  session: AuthorizedSession,
  projectId: string,
  input: { freeText: ConsistencyCheckField[]; structured?: ConsistencyCheckField[]; locale?: string },
): Promise<{ findings: AiConsistencyFinding[] | null; error?: string }> {
  // Only editors can save the wizard, and this check is part of that save flow —
  // align it with generateProjectSummary (also 'project:edit') rather than the
  // broader 'project:view'.
  await requireProjectAccess(session, projectId, 'project:edit')

  try {
    const backendRes = await fetch(`${getBackendUrl()}/v1/consistency-check`, {
      method: 'POST',
      // Forward the org id so the backend can resolve this org's BYOK LLM
      // credential (falls back to the platform env chain when unset).
      headers: { 'Content-Type': 'application/json', 'x-grid-organization-id': session.organizationId },
      body: JSON.stringify({
        free_text: input.freeText,
        structured: input.structured ?? [],
        locale: input.locale ?? 'de',
      }),
      // A hung backend must never block the save — bound the call and let the
      // TimeoutError land in the fail-open catch below.
      signal: AbortSignal.timeout(CONSISTENCY_CHECK_TIMEOUT_MS),
    })

    if (!backendRes.ok) {
      const errorText = await backendRes.text().catch(() => '')
      console.warn('[ConsistencyCheck] Backend error (non-fatal):', backendRes.status, errorText)
      return { findings: null, error: 'check_failed' }
    }

    const { findings, error } = (await backendRes.json()) as {
      findings: BackendConsistencyFinding[] | null
      error?: string | null
    }
    if (findings == null) return { findings: null, error: error ?? undefined }
    return {
      findings: findings.map(toAiFinding).filter((f): f is AiConsistencyFinding => f !== null),
      error: error ?? undefined,
    }
  } catch (e) {
    // Transport failure to the backend — degrade to "no findings" so the wizard
    // proceeds. Never surface this as a save-blocking error.
    console.warn('[ConsistencyCheck] Request failed (non-fatal):', e)
    return { findings: null, error: 'check_request_failed' }
  }
}

/**
 * Generate an AI summary of the profile via the Python backend and persist it
 * onto profileDisplay. Fully best-effort: every failure mode — backend
 * unreachable, timeout, non-2xx, or the backend's own diagnostic code —
 * resolves to HTTP 200 with `{ summary: '', error }` so callers (the brief's
 * auto/manual generate) can render a state instead of a blown-up request.
 *
 * The LLM is fed the human-readable brief rendering (question/option labels),
 * not the machine prompt view — raw tokens like `fluchtniveau=7-11m` were
 * leaking verbatim into the generated prose. `locale` controls the output
 * language (mirrors the consistency check; defaults to German).
 */
export async function generateProjectSummary(
  session: AuthorizedSession,
  projectId: string,
  options?: { locale?: string },
): Promise<{ summary: string; error?: string }> {
  await requireProjectAccess(session, projectId, 'project:edit')

  const state = await findProjectProfileInOrg(projectId, session.organizationId)
  if (!state) throw new NotFoundError()

  const profileText = buildProjectSummaryText(state.profile)
  if (!profileText) {
    return { summary: '' }
  }

  // The locale the backend actually writes the prose in (mirrors its own
  // default). Persisted with the summary so the brief can later detect a
  // stale-language summary after a UI locale switch.
  const locale = options?.locale ?? 'de'

  let backendRes: Response
  try {
    backendRes = await fetch(`${getBackendUrl()}/v1/generate-summary`, {
      method: 'POST',
      // Forward the org id so the backend can resolve this org's BYOK LLM
      // credential (falls back to the platform env chain when unset).
      headers: { 'Content-Type': 'application/json', 'x-grid-organization-id': session.organizationId },
      body: JSON.stringify({ profile_text: profileText, locale }),
      // Bound the call so an unreachable backend rejects promptly (as a
      // TimeoutError) instead of hanging into a Cloudflare 504.
      signal: AbortSignal.timeout(GENERATE_SUMMARY_TIMEOUT_MS),
    })
  } catch (e) {
    // Transport failure/timeout to the backend — degrade like every other
    // generation failure instead of surfacing a 500 to the caller.
    console.error('[GenerateSummary] Backend unreachable (non-fatal):', e)
    return { summary: '', error: 'backend_unreachable' }
  }

  if (!backendRes.ok) {
    const errorText = await backendRes.text().catch(() => '')
    console.error('[GenerateSummary] Backend error:', backendRes.status, errorText)
    return { summary: '', error: 'backend_error' }
  }

  const { summary, error } = (await backendRes.json()) as { summary: string; error?: string | null }

  if (error) {
    console.error('[GenerateSummary] Generation failed:', error)
    return { summary: '', error }
  }

  // Only persist a real summary — never let an empty result clobber an
  // existing good one. Record the locale it was generated in so a later UI
  // language switch can trigger exactly one regeneration.
  if (summary) {
    await setProjectProfileSummaryInOrg(projectId, session.organizationId, summary, locale)
  }

  return { summary }
}
