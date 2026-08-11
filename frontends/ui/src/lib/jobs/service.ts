/**
 * Jobs domain service — a project-scoped prompt on a timer.
 *
 * Responsibilities (ADR-0017): authorization (feature gate, project access),
 * business rules (cron validation, snapshot semantics, the single fire path)
 * and run recording. The service NEVER returns raw error statuses; it throws
 * typed errors from `@/lib/api/errors`.
 *
 * A job is a PROMPT. A skill may be attached on top — exactly as typing
 * `/name` before a message would attach it — and when one is, its body is
 * appended by `buildFirePrompt`. A skill knows nothing about time, and nothing
 * here reads scheduling or output intent out of skill metadata: `output` is the
 * user's choice on the job row.
 *
 * Fire-path tenancy: `fireJob` derives tenancy from the job row itself and
 * never throws for a skip — the manual "Run now" route and the internal
 * (scheduler) fire route share it.
 */

import 'server-only'
import { requireProjectAccess } from '@/lib/authz/projects'
import { enforcementOn, requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getBudgetStatus } from '@/lib/budgets/service'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { computeCollectionScope } from '@/lib/collection-scope'
import {
  buildGridRequestContextWireHeaders,
  encodeGridBudgetHeader,
  type GridBudgetSnapshot,
} from '@/lib/request-context'
import { isOrgFeatureEnabled, SKILLS_FLAG } from '@/lib/workos/feature-flags'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Job, JobOutput, JobRun, JobRunStatus, JobRunTrigger } from '@/lib/db/schema'
import { resolveSkillSnapshot, resolveSkillsForAgent } from '@/lib/skills/service'
import { snapshotOf, type SkillSnapshot } from '@/lib/skills/types'
import { nextOccurrence, validateCron, minIntervalMinutesFromEnv } from './schedule'
import {
  submitJob,
  JobSubmitError,
  JobSubmitSkippedError,
  type JobSubmitPayload,
} from './backend-client'
import * as repository from './repository'
import {
  AGENT_FOR_OUTPUT,
  emptySkillSnapshot,
  withAlwaysOnKnowledge,
  type CreateJobInput,
  type PatchJobInput,
} from './types'

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/**
 * Every session-facing call gates on the feature (routes do the same). Jobs
 * still ride the `skills` flag: they ship as one feature and are turned on
 * together, so a second flag would only add a way for them to disagree.
 */
function assertJobsFeatureOn(session: AuthorizedSession): void {
  if (requireSkillsEnabled(session)) {
    throw new ForbiddenError('Jobs are disabled.')
  }
}

// ---------------------------------------------------------------------------
// Attached skill + schedule resolution
// ---------------------------------------------------------------------------

/**
 * The attached skill, as the PAIR the database insists on.
 *
 * `skill_name IS NULL` iff `skill_snapshot IS NULL` (`jobs_skill_pair_check`),
 * so this resolves both together or neither — there is no code path that can
 * write a name with no body.
 */
async function resolveAttachedSkill(
  skillName: string | null | undefined,
  organizationId: string,
): Promise<{ skillName: string | null; skillSnapshot: SkillSnapshot | null }> {
  if (skillName == null || skillName === '') return { skillName: null, skillSnapshot: null }
  const snapshot = await resolveSkillSnapshot(skillName, organizationId)
  return { skillName: snapshot.name, skillSnapshot: snapshotOf(snapshot) }
}

/** next_run_at: the next future occurrence when scheduled + enabled, else null. */
function computeNextRunAt(
  scheduleCron: string | null,
  timezone: string,
  enabled: boolean,
): Date | null {
  if (!scheduleCron) return null
  const next = nextOccurrence(scheduleCron, timezone, new Date())
  return enabled ? next : null
}

/**
 * Validate the cron (shape, timezone, minimum interval) and compute the row's
 * next occurrence. There is no longer any veto from the attached skill:
 * `grid-schedulable` is gone, because whether something may run on a timer is a
 * property of the job, not of a skill that knows nothing about time.
 */
function resolveScheduleInputs(
  scheduleCron: string | null,
  scheduleTimezone: string,
  enabled: boolean,
): { nextRunAt: Date | null } {
  if (scheduleCron) {
    validateCron(scheduleCron, scheduleTimezone, minIntervalMinutesFromEnv())
  }
  return { nextRunAt: computeNextRunAt(scheduleCron, scheduleTimezone, enabled) }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listJobs(
  session: AuthorizedSession,
  projectId: string,
): Promise<{ jobs: Job[] }> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:view')
  const rows = await repository.listJobsInProject(projectId, session.organizationId)
  return { jobs: rows }
}

export async function getJob(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
): Promise<Job> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:view')
  const job = await repository.findJob(jobId, session.organizationId)
  if (!job || job.projectId !== projectId) throw new NotFoundError('Job not found.')
  return job
}

export async function createJob(
  session: AuthorizedSession,
  projectId: string,
  input: CreateJobInput,
): Promise<Job> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:skills:manage')

  const scheduleCron = input.scheduleCron ?? null
  const scheduleTimezone = input.scheduleTimezone ?? 'UTC'
  const enabled = input.enabled ?? true
  const attached = await resolveAttachedSkill(input.skillName, session.organizationId)
  const { nextRunAt } = resolveScheduleInputs(scheduleCron, scheduleTimezone, enabled)

  return repository.insertJob({
    projectId,
    organizationId: session.organizationId,
    name: input.name,
    prompt: input.prompt,
    skillName: attached.skillName,
    skillSnapshot: attached.skillSnapshot,
    output: input.output,
    // knowledge_layer is always included; the stored list is "additional sources".
    dataSources: withAlwaysOnKnowledge(input.dataSources ?? null),
    enabled,
    scheduleCron,
    scheduleTimezone,
    nextRunAt,
    createdBy: session.userId,
    createdByEmail: session.email,
  })
}

export async function updateJob(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
  patch: PatchJobInput,
): Promise<Job> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:skills:manage')

  const existing = await repository.findJob(jobId, session.organizationId)
  if (!existing || existing.projectId !== projectId) throw new NotFoundError('Job not found.')

  const scheduleCron = patch.scheduleCron !== undefined ? patch.scheduleCron : existing.scheduleCron
  const scheduleTimezone = patch.scheduleTimezone ?? existing.scheduleTimezone
  const enabled = patch.enabled ?? existing.enabled
  // `undefined` = leave the attachment alone; `null` = detach. Either way the
  // name and the snapshot move together.
  const attached =
    patch.skillName === undefined
      ? { skillName: existing.skillName, skillSnapshot: existing.skillSnapshot }
      : await resolveAttachedSkill(patch.skillName, session.organizationId)
  const { nextRunAt } = resolveScheduleInputs(scheduleCron, scheduleTimezone, enabled)

  const job = await repository.updateJob(jobId, session.organizationId, {
    name: patch.name,
    prompt: patch.prompt,
    skillName: attached.skillName,
    skillSnapshot: attached.skillSnapshot,
    output: patch.output,
    dataSources:
      patch.dataSources !== undefined ? withAlwaysOnKnowledge(patch.dataSources) : undefined,
    enabled,
    scheduleCron,
    scheduleTimezone,
    nextRunAt,
    updatedAt: new Date(),
  })
  if (!job) throw new NotFoundError('Job not found.')
  return job
}

export async function deleteJob(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
): Promise<{ deleted: true }> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:skills:manage')

  const existing = await repository.findJob(jobId, session.organizationId)
  if (!existing || existing.projectId !== projectId) throw new NotFoundError('Job not found.')
  await repository.deleteJob(jobId, session.organizationId)
  return { deleted: true }
}

export async function listJobRuns(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
  limit: number,
  offset: number,
): Promise<{ runs: JobRun[] }> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:view')

  const job = await repository.findJob(jobId, session.organizationId)
  if (!job || job.projectId !== projectId) throw new NotFoundError('Job not found.')
  const runs = await repository.listJobRuns(jobId, session.organizationId, { limit, offset })
  return { runs }
}

// ---------------------------------------------------------------------------
// Attachable skills — the payoff of consolidating availability on grid-agents
// ---------------------------------------------------------------------------

/** A skill the picker may offer for a given output kind. */
export type AttachableSkill = {
  name: string
  description: string
  /** Full body — the builder's WYSIWYG preview embeds it. */
  body: string
  metadata: Record<string, string>
  origin: 'org' | 'platform-clone' | 'platform'
}

/**
 * The skills attachable to a job with this output kind.
 *
 * `chat` runs on `shallow_researcher`, `deep-research` on `deep_researcher`
 * (`AGENT_FOR_OUTPUT`, the mirror of the backend's `_OUTPUT_AGENT_TYPES`), and
 * availability is resolved from `grid-agents` — the ONE gate. The picker must
 * not offer a skill the chosen output cannot run, which is exactly why the
 * availability rules were consolidated onto that single key.
 */
export async function listAttachableSkills(
  session: AuthorizedSession,
  output: JobOutput,
): Promise<{ skills: AttachableSkill[] }> {
  assertJobsFeatureOn(session)
  const { skills } = await resolveSkillsForAgent(session.organizationId, AGENT_FOR_OUTPUT[output])
  return {
    skills: [...skills].sort((left, right) => left.name.localeCompare(right.name)),
  }
}

// ---------------------------------------------------------------------------
// Fire path (manual + scheduler share it)
// ---------------------------------------------------------------------------

/** Manual "Run now": fires an enabled job with the caller's identity. */
export async function runJobNow(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
): Promise<JobRun> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:skills:manage')

  const job = await repository.findJob(jobId, session.organizationId)
  if (!job || job.projectId !== projectId) throw new NotFoundError('Job not found.')
  if (!job.enabled) throw new ConflictError('This job is disabled.')
  return fireJob(job, 'manual', session.userId)
}

/** What `buildFirePrompt` needs: the job's prompt and its attached skill, if any. */
export interface FirePromptInput {
  prompt: string
  skill: SkillSnapshot | null
}

/**
 * The deterministic prompt a run is submitted with.
 *
 * The job's prompt ALWAYS, exactly as a person would have typed it into a new
 * chat, plus the attached skill's full body when there is one — the `/name`
 * relationship, written out. With no skill attached the output is the prompt
 * and nothing else: no `Skill:`/`Beschreibung:` block, no dangling fences.
 *
 * WYSIWYG contract: `src/features/skills/lib/fire-prompt-preview.ts` is a
 * byte-identical transcription of this function and a spec pins that they
 * agree. Whoever changes one changes the other in the same commit.
 */
export function buildFirePrompt({ prompt, skill }: FirePromptInput): string {
  const text = prompt.trim()
  if (!skill) return text
  return [
    text,
    '',
    '---',
    '',
    'Verwende dabei den folgenden Skill verbindlich und vollständig.',
    '',
    `Skill: ${skill.name}`,
    `Beschreibung: ${skill.description}`,
    '',
    skill.body,
    '---',
  ].join('\n')
}

/**
 * The single submission path (manual + scheduled). Context building sits
 * inside the try: a transient DB/WorkOS failure surfaces as an `error` run
 * row, never as an unrecorded throw — the job advances past this occurrence
 * regardless.
 */
export async function fireJob(
  job: Job,
  trigger: JobRunTrigger,
  actor: string,
): Promise<JobRun> {
  const { organizationId, projectId, createdBy } = job

  try {
    const [budgetSnapshot, modelOverrides, collectionScope, projectContext, bundesland] =
      await Promise.all([
        resolveBudgetSnapshot(organizationId, createdBy, projectId),
        getEffectiveModelOverrides(organizationId).catch(() => null),
        buildProjectCollectionScope(projectId, organizationId),
        loadProjectPromptView(projectId, organizationId).catch(() => null),
        loadProjectBundesland(projectId, organizationId).catch(() => null),
      ])
    const budgetHeader = budgetSnapshot ? encodeGridBudgetHeader(budgetSnapshot) : null

    // TODO(jobs): an `output: 'chat'` run should land in a conversation the
    // team can open and continue, and this is where that conversation would be
    // created. It is NOT created yet: the ownership/visibility model is pending
    // redesign. `conversations.visibility` defaults to 'private' and
    // `created_by` is one person, but a job is a team artefact scheduled on a
    // project whose runs are already readable by anyone with `project:view` —
    // so a private conversation attributed to a single human is the wrong
    // default on both axes, and whether the scheduler should carry its own
    // participant identity rather than borrow the job owner's is still open.
    // The plumbing below is the finished seam: set `conversationId` here, and
    // it rides the submit payload as `conversation_id` and lands on the
    // job_runs row. Until then it stays null and nothing writes a conversation.
    const conversationId: string | null = null

    const payload: JobSubmitPayload = {
      input: buildFirePrompt({ prompt: job.prompt, skill: job.skillSnapshot }),
      // Empty when no skill is attached: the prompt runs alone, which the
      // backend now accepts.
      skills: job.skillSnapshot ? [job.skillSnapshot.name] : [],
      output: job.output,
      // Seam only — see the TODO above; nothing sets this yet.
      ...(conversationId ? { conversation_id: conversationId } : {}),
      // Defense for legacy rows persisted before knowledge_layer was always-on.
      data_sources: withAlwaysOnKnowledge(job.dataSources ?? null),
      collection_scope: collectionScope,
      project_context: projectContext,
      organization_id: organizationId,
      user_id: createdBy,
      project_id: projectId,
      owner_email: job.createdByEmail,
      budget_header: budgetHeader,
      model_overrides: modelOverrides,
    }

    // Signed context envelope (same wire format as fireWorkflow): built from
    // the exact values above via the shared GridRequestContext builder so the
    // job path's wire format can never drift from the interactive one.
    const contextHeaders = buildGridRequestContextWireHeaders(
      {
        organizationId,
        userId: createdBy,
        projectId,
        collectionScope,
        projectContext,
        modelOverrides,
        budget: budgetSnapshot,
        bundesland,
      },
      process.env.GRID_INTERNAL_API_TOKEN,
    )

    const { jobId } = await submitJob(payload, contextHeaders)
    return recordJobRun(job, trigger, actor, 'submitted', jobId, null, conversationId)
  } catch (err) {
    if (err instanceof JobSubmitSkippedError) {
      const detail =
        err.retryAfterSeconds != null
          ? `${err.message} (retry after ${err.retryAfterSeconds}s)`
          : err.message
      return recordJobRun(job, trigger, actor, 'skipped', null, detail, null)
    }
    if (err instanceof JobSubmitError) {
      return recordJobRun(job, trigger, actor, 'error', null, err.message, null)
    }
    const detail = err instanceof Error ? err.message : 'Unexpected error while preparing the run'
    return recordJobRun(job, trigger, actor, 'error', null, detail, null)
  }
}

async function recordJobRun(
  job: Job,
  trigger: JobRunTrigger,
  actor: string,
  status: JobRunStatus,
  backendJobId: string | null,
  detail: string | null,
  conversationId: string | null,
): Promise<JobRun> {
  const run = await repository.insertJobRun({
    scheduleId: job.id,
    projectId: job.projectId,
    organizationId: job.organizationId,
    jobId: backendJobId,
    trigger,
    status,
    detail,
    conversationId,
    // `{}` for a skill-less job — job_runs.skill_snapshot is NOT NULL so run
    // history keeps one shape to read.
    skillSnapshot: job.skillSnapshot ? snapshotOf(job.skillSnapshot) : emptySkillSnapshot(),
    triggeredBy: actor,
  })
  await repository.touchJobLastRun(job.id, run.createdAt)
  return run
}

/** Internal (scheduler) fire: load a job by id WITHOUT an org filter. */
export async function loadJobForFire(jobId: string): Promise<Job | null> {
  return repository.findJobById(jobId)
}

/**
 * The scheduler's gate: disabled job → `disabled`; with WorkOS flag
 * enforcement the per-org `skills` flag is checked and a failure records a
 * `skipped` run (fail-closed); otherwise the run fires with scheduler
 * identity. `fireJob` itself never throws for a skip.
 */
export async function fireScheduledJob(
  job: Job,
): Promise<{ fired: boolean; jobId?: string; reason?: 'disabled' | 'feature-disabled' | 'skipped' | 'error' }> {
  if (!job.enabled) {
    return { fired: false, reason: 'disabled' }
  }
  if (enforcementOn()) {
    let flagOn = false
    try {
      flagOn = await isOrgFeatureEnabled(job.organizationId, SKILLS_FLAG)
    } catch {
      flagOn = false
    }
    if (!flagOn) {
      await recordJobRun(
        job,
        'schedule',
        'scheduler',
        'skipped',
        null,
        'Skills feature disabled for organization',
        null,
      )
      return { fired: false, reason: 'feature-disabled' }
    }
  }
  const run = await fireJob(job, 'schedule', 'scheduler')
  if (run.status === 'submitted') return { fired: true, jobId: run.jobId ?? undefined }
  return { fired: false, reason: run.status === 'skipped' ? 'skipped' : 'error' }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The raw remaining-budget snapshot — identical values to the interactive
 * path's `x-grid-budget` header. Best-effort: a lookup failure must not block
 * the run.
 */
async function resolveBudgetSnapshot(
  organizationId: string,
  userId: string,
  projectId: string,
): Promise<GridBudgetSnapshot | null> {
  try {
    const status = await getBudgetStatus(organizationId, userId, projectId)
    return {
      remainingOrgUsd: status.remainingOrgUsd,
      remainingUserUsd: status.remainingUserUsd,
      remainingProjectUsd: status.remainingProjectUsd,
    }
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
