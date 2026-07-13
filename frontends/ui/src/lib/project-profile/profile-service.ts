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
import { BadRequestError, ConflictError, NotFoundError, UpstreamError } from '@/lib/api/errors'
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
  invalidateProjectPromptViewCache,
  loadProjectPromptView,
} from './prompt-view'
import { normalizeProfilePatchOperations, pruneResolvedUnknowns } from './patch-engine'
import {
  projectIntakeDefinitionV1,
  validateProfilePatchVocabulary,
  type ProjectIntakeDefinition,
} from './intake-definition'
import type { ProjectProfile, ProjectProfilePatchOperation } from './types'

export async function getProjectProfile(
  session: AuthorizedSession,
  projectId: string,
): Promise<ProjectProfileState> {
  await requireProjectAccess(session, projectId, 'project:view')
  const state = await findProjectProfileInOrg(projectId, session.organizationId)
  if (!state) throw new NotFoundError()
  return state
}

/** Replace the whole profile (intake wizard save). 409 on a version conflict. */
export async function saveProjectProfile(
  session: AuthorizedSession,
  projectId: string,
  profile: ProjectProfile,
): Promise<ProjectProfileState> {
  await requireProjectAccess(session, projectId, 'project:edit')
  const current = await findProjectProfileInOrg(projectId, session.organizationId)
  if (!current) throw new NotFoundError()
  return persistProfile(projectId, session.organizationId, profile, current)
}

/**
 * Apply agent-proposed patch operations to the stored profile. Bare values
 * are wrapped with provenance (accepting the card is the user confirmation),
 * then any unknowns the patch just answered are retired. 409 on a version
 * conflict.
 */
export async function patchProjectProfile(
  session: AuthorizedSession,
  projectId: string,
  operations: ProjectProfilePatchOperation[],
): Promise<ProjectProfileState> {
  await requireProjectAccess(session, projectId, 'project:edit')
  const current = await findProjectProfileInOrg(projectId, session.organizationId)
  if (!current) throw new NotFoundError()

  let profile: ProjectProfile
  try {
    // Defense-in-depth: reject values that violate the intake vocabulary before
    // they are wrapped with `user_confirmed` provenance and persisted.
    validateProfilePatchVocabulary(operations)
    const normalized = normalizeProfilePatchOperations(operations)
    profile = pruneResolvedUnknowns(applyProjectProfilePatch(current.profile, normalized))
  } catch (error) {
    throw new BadRequestError(
      error instanceof Error ? error.message : 'Invalid project profile patch.',
    )
  }

  return persistProfile(projectId, session.organizationId, profile, current)
}

/**
 * Optimistic-concurrency write shared by save and patch: rebuild the derived
 * prompt/display views (preserving the async-generated summary), bump the
 * version, and refuse the write when a concurrent request got there first.
 */
async function persistProfile(
  projectId: string,
  organizationId: string,
  profile: ProjectProfile,
  current: ProjectProfileState,
): Promise<ProjectProfileState> {
  const updated = await updateProjectProfileIfVersion(projectId, organizationId, current.profileVersion, {
    profile,
    profileVersion: current.profileVersion + 1,
    profilePromptView: buildProjectPromptView(profile),
    profileDisplay: buildProjectProfileDisplay(profile, current.profileDisplay?.summary ?? ''),
    profileUpdatedAt: new Date(),
  })
  if (!updated) throw new ConflictError('Conflict: profile was modified by another request')

  await invalidateProjectPromptViewCache(projectId)
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

/**
 * Generate an AI summary of the profile via the Python backend and persist it
 * onto profileDisplay. Best-effort contract: generation failures are
 * non-fatal (HTTP 200 with the backend's diagnostic code); only a transport
 * failure to the backend is a 502.
 */
export async function generateProjectSummary(
  session: AuthorizedSession,
  projectId: string,
): Promise<{ summary: string; error?: string }> {
  await requireProjectAccess(session, projectId, 'project:edit')

  const profileText = await loadProjectPromptView(projectId)
  if (!profileText) {
    return { summary: '' }
  }

  const backendRes = await fetch(`${getBackendUrl()}/v1/generate-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_text: profileText }),
  })

  if (!backendRes.ok) {
    const errorText = await backendRes.text()
    console.error('[GenerateSummary] Backend error:', backendRes.status, errorText)
    throw new UpstreamError('Summary generation failed')
  }

  const { summary, error } = (await backendRes.json()) as { summary: string; error?: string | null }

  if (error) {
    console.error('[GenerateSummary] Generation failed:', error)
    return { summary: '', error }
  }

  // Only persist a real summary — never let an empty result clobber an
  // existing good one.
  if (summary) {
    await setProjectProfileSummaryInOrg(projectId, session.organizationId, summary)
  }

  await invalidateProjectPromptViewCache(projectId)

  return { summary }
}
