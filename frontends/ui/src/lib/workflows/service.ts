/**
 * Workflows service — business logic + authorization for the workflows domain
 * (ADR-0023, docs/architecture/workflows.md).
 *
 * Every session-facing function authorizes via `requireProjectAccess` (read =
 * `project:view`; mutate/run = `project:edit`, the slug existing project-content
 * mutation services use) and double-filters every query by
 * `session.organizationId`. `fireWorkflow` is the single submission path shared
 * by the manual "Run now" route and the internal (scheduler) fire route; it
 * derives tenancy from the workflow row itself and never throws for a skip.
 */

import 'server-only'
import { requireProjectAccess } from '@/lib/authz/projects'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getBudgetStatus } from '@/lib/budgets/service'
import { getActiveModelOverrides } from '@/lib/model-config/service'
import { loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { computeCollectionScope } from '@/lib/collection-scope'
import { isOrgFeatureEnabled, WORKFLOWS_FLAG } from '@/lib/workos/feature-flags'
import { enforcementOn } from '@/lib/authz/feature-flags'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  DEFAULT_WORKFLOW_AGENT_TYPE,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowTrigger,
} from '@/lib/db/schema'
import { compileWorkflowPrompt } from './compiler'
import { minIntervalMinutesFromEnv, nextOccurrence, validateCron } from './schedule'
import {
  submitWorkflowJob,
  WorkflowSubmitError,
  WorkflowSubmitSkippedError,
  type WorkflowSubmitPayload,
} from './backend-client'
import * as repository from './repository'
import { withAlwaysOnKnowledge } from './types'
import type { CreateWorkflowInput, PatchWorkflowInput } from './types'

// ---------------------------------------------------------------------------
// CRUD + run history (session-facing)
// ---------------------------------------------------------------------------

export async function listWorkflows(session: AuthorizedSession, projectId: string): Promise<Workflow[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  return repository.listWorkflowsInProject(projectId, session.organizationId)
}

export async function getWorkflow(
  session: AuthorizedSession,
  projectId: string,
  workflowId: string,
): Promise<Workflow> {
  await requireProjectAccess(session, projectId, 'project:view')
  const workflow = await repository.findWorkflow(workflowId, session.organizationId)
  if (!workflow || workflow.projectId !== projectId) throw new NotFoundError()
  return workflow
}

export async function createWorkflow(
  session: AuthorizedSession,
  projectId: string,
  input: CreateWorkflowInput,
): Promise<Workflow> {
  // Tenancy is covered by requireProjectAccess: it verifies the project exists
  // and belongs to the caller's org (findProjectTenancy) before any FGA check.
  await requireProjectAccess(session, projectId, 'project:edit')

  const compiledPrompt = compileWorkflowPrompt(input.definition)
  const timezone = input.scheduleTimezone ?? 'UTC'
  const enabled = input.enabled ?? true
  const scheduleCron = input.scheduleCron ?? null

  const nextRunAt = computeNextRunAt(scheduleCron, timezone, enabled)

  return repository.insertWorkflow({
    projectId,
    organizationId: session.organizationId,
    name: input.name,
    description: input.description ?? null,
    definition: input.definition,
    compiledPrompt,
    agentType: DEFAULT_WORKFLOW_AGENT_TYPE,
    // knowledge_layer is always included; the stored list is "additional sources".
    dataSources: withAlwaysOnKnowledge(input.dataSources ?? null),
    enabled,
    scheduleCron,
    scheduleTimezone: timezone,
    nextRunAt,
    createdBy: session.userId,
    createdByEmail: session.email,
  })
}

export async function updateWorkflow(
  session: AuthorizedSession,
  projectId: string,
  workflowId: string,
  patch: PatchWorkflowInput,
): Promise<Workflow> {
  await requireProjectAccess(session, projectId, 'project:edit')

  const existing = await repository.findWorkflow(workflowId, session.organizationId)
  if (!existing || existing.projectId !== projectId) throw new NotFoundError()

  const definition = patch.definition ?? existing.definition
  const compiledPrompt = patch.definition ? compileWorkflowPrompt(patch.definition) : existing.compiledPrompt
  const timezone = patch.scheduleTimezone ?? existing.scheduleTimezone
  const scheduleCron = patch.scheduleCron !== undefined ? patch.scheduleCron : existing.scheduleCron
  const enabled = patch.enabled ?? existing.enabled

  const nextRunAt = computeNextRunAt(scheduleCron, timezone, enabled)

  const updated = await repository.updateWorkflow(workflowId, session.organizationId, {
    name: patch.name ?? existing.name,
    description: patch.description !== undefined ? patch.description : existing.description,
    definition,
    compiledPrompt,
    // knowledge_layer is always included; the stored list is "additional sources".
    dataSources: withAlwaysOnKnowledge(
      patch.dataSources !== undefined ? (patch.dataSources ?? null) : existing.dataSources,
    ),
    enabled,
    scheduleCron,
    scheduleTimezone: timezone,
    nextRunAt,
    updatedAt: new Date(),
  })
  if (!updated) throw new NotFoundError()
  return updated
}

export async function deleteWorkflow(
  session: AuthorizedSession,
  projectId: string,
  workflowId: string,
): Promise<void> {
  await requireProjectAccess(session, projectId, 'project:edit')

  const existing = await repository.findWorkflow(workflowId, session.organizationId)
  if (!existing || existing.projectId !== projectId) throw new NotFoundError()

  await repository.deleteWorkflow(workflowId, session.organizationId)
}

export async function listRuns(
  session: AuthorizedSession,
  projectId: string,
  workflowId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<WorkflowRun[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  const workflow = await repository.findWorkflow(workflowId, session.organizationId)
  if (!workflow || workflow.projectId !== projectId) throw new NotFoundError()
  return repository.listWorkflowRuns(workflowId, session.organizationId, options)
}

/**
 * Manual "Run now": edit permission required, 409 when disabled. Delegates to
 * the shared `fireWorkflow` path (surfaces a backend 429 as a friendly
 * `skipped` run, never a hard error).
 */
export async function runWorkflowNow(
  session: AuthorizedSession,
  projectId: string,
  workflowId: string,
): Promise<WorkflowRun> {
  await requireProjectAccess(session, projectId, 'project:edit')
  const workflow = await repository.findWorkflow(workflowId, session.organizationId)
  if (!workflow || workflow.projectId !== projectId) throw new NotFoundError()
  if (!workflow.enabled) throw new ConflictError('Workflow is disabled.')
  return fireWorkflow(workflow, 'manual', session.userId)
}

// ---------------------------------------------------------------------------
// Internal fire path (no session)
// ---------------------------------------------------------------------------

/**
 * Load a workflow by id (no session) for the internal fire endpoint the
 * scheduler calls. Returns null when missing; the route re-checks `enabled`.
 */
export async function loadWorkflowForFire(workflowId: string): Promise<Workflow | null> {
  return repository.findWorkflowById(workflowId)
}

export type ScheduledFireResult =
  | { fired: true; run: WorkflowRun }
  | { fired: false; reason: 'disabled' }
  | { fired: false; reason: 'feature-disabled'; run: WorkflowRun }

/**
 * Scheduled-fire wrapper around `fireWorkflow` with two race guards the
 * session-less scheduler path needs:
 *
 * 1. `enabled` — the row may have been disabled between claim and fire.
 * 2. The org's `workflows` feature gate. Session routes are already gated, but
 *    flag delivery is JWT-based, so without this check revoking an org's flag
 *    would block the UI while its schedules keep firing (ADR-0023 risk). Under
 *    `GRID_ENFORCE_FEATURE_FLAGS` the WorkOS flag is evaluated per-org
 *    (cached, FAIL-CLOSED — a flag outage pauses scheduled research rather
 *    than running it ungated); otherwise the `GRID_WORKFLOWS_ENABLED`
 *    deployment gate applies. A flag skip is recorded as a `skipped` run so
 *    the pause is visible in run history.
 */
export async function fireScheduledWorkflow(workflow: Workflow): Promise<ScheduledFireResult> {
  if (!workflow.enabled) {
    return { fired: false, reason: 'disabled' }
  }
  if (!(await isWorkflowsEnabledForOrg(workflow.organizationId))) {
    const run = await recordRun(
      workflow,
      'schedule',
      'scheduler',
      'skipped',
      null,
      'Workflows feature is disabled for this organization',
    )
    return { fired: false, reason: 'feature-disabled', run }
  }
  const run = await fireWorkflow(workflow, 'schedule', 'scheduler')
  return { fired: true, run }
}

/** Org-level gate for session-less paths, mirroring `isWorkflowsEnabled`. */
async function isWorkflowsEnabledForOrg(organizationId: string): Promise<boolean> {
  if (enforcementOn()) {
    return isOrgFeatureEnabled(WORKFLOWS_FLAG, organizationId, false)
  }
  return (process.env.GRID_WORKFLOWS_ENABLED ?? '').toLowerCase() === 'true'
}

// ---------------------------------------------------------------------------
// The single submission path
// ---------------------------------------------------------------------------

/**
 * Submit a workflow run through the backend and record its outcome. Identity is
 * the workflow's creator (owner), tenancy is the workflow row's own org — so
 * this is safe for the session-less scheduler path. Attaches the SAME budget +
 * model-override + collection-scope context the interactive async-submit path
 * carries (server.js x-grid-budget / x-grid-model-overrides / x-grid-collection-scope).
 *
 * Records a `workflow_runs` row (submitted / skipped / error) and advances
 * `last_run_at`. Never throws for a skip (429); an occurrence is not retried
 * before its next slot.
 */
export async function fireWorkflow(
  workflow: Workflow,
  trigger: WorkflowTrigger,
  actor: string,
): Promise<WorkflowRun> {
  const { organizationId, projectId, createdBy } = workflow

  try {
    // Context building is inside the try: a transient DB/WorkOS failure here
    // (e.g. the project lookup for the collection scope) must surface as an
    // 'error' run row, not an unrecorded throw — the schedule has already
    // advanced past this occurrence, so a silent loss would leave no trace.
    const [budgetHeader, modelOverrides, collectionScope, projectContext] = await Promise.all([
      buildBudgetHeader(organizationId, createdBy, projectId),
      getActiveModelOverrides(organizationId).catch(() => null),
      buildProjectCollectionScope(projectId, organizationId),
      loadProjectPromptView(projectId).catch(() => null),
    ])

    const payload: WorkflowSubmitPayload = {
      agent_type: workflow.agentType,
      input: workflow.compiledPrompt,
      // Defense for legacy rows persisted before knowledge_layer was always-on.
      data_sources: withAlwaysOnKnowledge(workflow.dataSources ?? null),
      collection_scope: collectionScope,
      project_context: projectContext,
      organization_id: organizationId,
      user_id: createdBy,
      project_id: projectId,
      owner_email: workflow.createdByEmail,
      budget_header: budgetHeader,
      model_overrides: modelOverrides,
    }

    const { job_id } = await submitWorkflowJob(payload)
    return await recordRun(workflow, trigger, actor, 'submitted', job_id, null)
  } catch (err) {
    if (err instanceof WorkflowSubmitSkippedError) {
      const detail =
        err.retryAfterSeconds != null ? `${err.message} (retry after ${err.retryAfterSeconds}s)` : err.message
      return recordRun(workflow, trigger, actor, 'skipped', null, detail)
    }
    if (err instanceof WorkflowSubmitError) {
      return recordRun(workflow, trigger, actor, 'error', null, err.message)
    }
    const detail = err instanceof Error ? err.message : 'Unexpected error while preparing the run'
    return recordRun(workflow, trigger, actor, 'error', null, detail)
  }
}

async function recordRun(
  workflow: Workflow,
  trigger: WorkflowTrigger,
  actor: string,
  status: WorkflowRunStatus,
  jobId: string | null,
  detail: string | null,
): Promise<WorkflowRun> {
  const run = await repository.insertWorkflowRun({
    workflowId: workflow.id,
    projectId: workflow.projectId,
    organizationId: workflow.organizationId,
    jobId,
    trigger,
    status,
    detail,
    promptSnapshot: workflow.compiledPrompt,
    triggeredBy: actor,
  })
  await repository.touchWorkflowLastRun(workflow.id, run.createdAt)
  return run
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** next_run_at: the next future occurrence when scheduled + enabled, else null. */
function computeNextRunAt(scheduleCron: string | null, timezone: string, enabled: boolean): Date | null {
  if (!scheduleCron) return null
  validateCron(scheduleCron, timezone, minIntervalMinutesFromEnv())
  return enabled ? nextOccurrence(scheduleCron, timezone, new Date()) : null
}

/**
 * The base64url budget snapshot the backend cost tracker reads — identical
 * value to the interactive path's `x-grid-budget` header. Fail-open (null) on
 * read error, mirroring the WS-scope route: a broken budget lookup must not
 * take firing down.
 */
async function buildBudgetHeader(
  organizationId: string,
  userId: string,
  projectId: string,
): Promise<string | null> {
  try {
    const status = await getBudgetStatus(organizationId, userId, projectId)
    const snapshot = {
      remainingOrgUsd: status.remainingOrgUsd,
      remainingUserUsd: status.remainingUserUsd,
      remainingProjectUsd: status.remainingProjectUsd,
    }
    return Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64url')
  } catch {
    return null
  }
}

/**
 * The ordered collection scope for the project — exactly what
 * buildCollectionScopeFromRequest produces for a project (base collection +
 * the project's real `proj_<uuid>` collection). Resolved from the project row
 * (session-less path); falls back to the id-derived name if the row is gone.
 */
async function buildProjectCollectionScope(
  projectId: string,
  organizationId: string,
): Promise<string[] | null> {
  const project = await findProjectInOrg(projectId, organizationId)
  const scope = computeCollectionScope(null, {
    projectId,
    projectCollectionName: project?.collectionName,
    includeProject: true,
  })
  return scope.length > 0 ? scope : null
}
