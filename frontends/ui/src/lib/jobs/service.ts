/**
 * Definitions service — the standing intent and the fire path (the arrival of
 * jobs + delegated tasks at one entity, migration 0086).
 *
 * A definition says what was asked, by whom, and what makes it run. A
 * `schedule` fires on its cron; a `once` definition is a delegation; a `manual`
 * one only runs when a person presses "Run now". This module owns the
 * definition CRUD and the single submission path (`fireJob`); the run
 * lifecycle, filing and review live next door in `@/lib/tasks/service` over
 * the same `task_runs` table.
 *
 * The HTTP contract is deliberately unchanged: the project-scoped `/jobs`
 * routes still answer the shapes the UI's jobs client parses (`name`, `prompt`,
 * `output`, …), and this module projects a definition onto that shape. That
 * projection is the seam at which the old wire model meets the new storage
 * model; it disappears when the UI moves to definitions in the same release.
 */

import 'server-only'
// Explicit, not the `crypto` global: this module is server-only and the global
// is not guaranteed in every Node/test environment the service is loaded in.
import { randomUUID } from 'node:crypto'
import { requireProjectAccess } from '@/lib/authz/projects'
import { enforcementOn, requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { insertConversation } from '@/lib/conversations/repository'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getBudgetStatus } from '@/lib/budgets/service'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { resolveOrgInstructions } from '@/lib/org-instructions/service'
import { computeCollectionScope } from '@/lib/collection-scope'
import {
  buildGridRequestContextWireHeaders,
  encodeGridBudgetHeader,
  type GridBudgetSnapshot,
} from '@/lib/request-context'
import { isMemoryReflectionEnabled, isOrgFeatureEnabled, SKILLS_FLAG } from '@/lib/workos/feature-flags'
import type { AuthorizedSession } from '@/lib/auth/types'
import type {
  DefinitionTrigger,
  JobOutput,
  TaskDefinition,
  TaskRun,
  TaskRunTrigger,
} from '@/lib/db/schema'
import { resolveSkillSnapshot } from '@/lib/skills/service'
import { snapshotOf, type SkillSnapshot } from '@/lib/skills/types'
import { nextOccurrence, validateCron, validateDueAt, minIntervalMinutesFromEnv } from './schedule'
import {
  submitJob,
  JobSubmitError,
  JobSubmitSkippedError,
  type JobSubmitPayload,
} from './backend-client'
import * as repository from '@/lib/tasks/repository'
import { previousDecisionsBlock } from '@/lib/tasks/service'
import { taskThreadConversationId } from '@/lib/tasks/task-thread'
import { createRunMessage } from '@/lib/runs/service'
import {
  emptySkillSnapshot,
  withAlwaysOnSources,
  type CreateJobInput,
  type PatchJobInput,
} from './types'

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/**
 * Every session-facing call gates on the feature (routes do the same).
 * Definitions still ride the `skills` flag: they ship as one feature and are
 * turned on together, so a second flag would only add a way for them to
 * disagree.
 */
function assertJobsFeatureOn(session: AuthorizedSession): void {
  if (requireSkillsEnabled(session)) {
    throw new ForbiddenError('Jobs are disabled.')
  }
}

// ---------------------------------------------------------------------------
// Wire projections
// ---------------------------------------------------------------------------

/**
 * A definition as the `/jobs` wire has always described one. The UI's
 * `jobs-client.ts` parses exactly these fields, and `name`/`prompt`/`output`
 * are that model's words for `title`/`plan.prompt`/`kind`.
 */
export interface JobView {
  id: string
  projectId: string
  name: string
  prompt: string
  skillName: string | null
  skillSnapshot: SkillSnapshot | null
  output: JobOutput
  dataSources: string[] | null
  enabled: boolean
  scheduleCron: string | null
  scheduleTimezone: string
  /** When a one-shot is due; null on a recurring or manual task. */
  dueAt: Date | null
  nextRunAt: Date | null
  lastRunAt: Date | null
  createdBy: string
  createdByEmail: string | null
  createdAt: Date
  updatedAt: Date
}

/** The `job_runs` words for a `task_runs` row (the run-history wire shape). */
export interface JobRunView {
  id: string
  /** The parent's id. `schedule_id` on the wire, `definition_id` in storage. */
  scheduleId: string
  /** The BACKEND async-job id. Null when skipped/error. */
  jobId: string | null
  trigger: TaskRunTrigger
  status: 'submitted' | 'skipped' | 'error'
  detail: string | null
  conversationId: string | null
  skillSnapshot: SkillSnapshot
  triggeredBy: string | null
  createdAt: Date
}

function toJobView(definition: TaskDefinition): JobView {
  const skill = definition.plan.skill
  const hasSkill = Boolean(skill && skill.name)
  return {
    id: definition.id,
    projectId: definition.projectId,
    name: definition.title,
    prompt: definition.plan.prompt,
    skillName: hasSkill ? skill.name : null,
    skillSnapshot: hasSkill ? skill : null,
    output: definition.kind === 'deep-research' ? 'deep-research' : 'chat',
    dataSources: definition.plan.dataSources,
    enabled: definition.enabled,
    scheduleCron: definition.scheduleCron,
    scheduleTimezone: definition.scheduleTimezone,
    dueAt: definition.dueAt,
    nextRunAt: definition.nextRunAt,
    lastRunAt: definition.lastRunAt,
    createdBy: definition.requesterUserId,
    createdByEmail: definition.requesterEmail,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  }
}

function toJobRunView(run: TaskRun): JobRunView {
  return {
    id: run.id,
    scheduleId: run.definitionId ?? '',
    jobId: run.backendJobId,
    trigger: run.trigger,
    // The old submission vocabulary: a worker outcome never reached this list,
    // so every non-skip/non-error attempt reads `submitted`.
    status: run.status === 'skipped' || run.status === 'error' ? run.status : 'submitted',
    detail: run.error,
    conversationId: run.conversationId,
    skillSnapshot: run.skillSnapshot,
    triggeredBy: run.triggeredBy,
    createdAt: run.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Attached skill + schedule resolution
// ---------------------------------------------------------------------------

/** The attached skill, pinned as the snapshot pair the run will carry. */
async function resolveAttachedSkill(
  skillName: string | null | undefined,
  organizationId: string,
): Promise<{ skillName: string | null; skillSnapshot: SkillSnapshot }> {
  if (skillName == null || skillName === '') {
    return { skillName: null, skillSnapshot: emptySkillSnapshot() }
  }
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
 * Validate when this should run and compute the one column the scheduler scans.
 *
 * `next_run_at` means the same thing for all three triggers — "when the due
 * scan should next look at this row" — which is what lets ONE partial index and
 * ONE claim query serve both a cron and a one-shot (migration 0090):
 *
 *   - a cron gets its next occurrence, after the shape/timezone/min-interval
 *     check. There is no veto from the attached skill: whether something may
 *     run on a timer is a property of the work.
 *   - a one-shot gets its own due date, after the future/horizon check.
 *   - a manual definition gets NULL, and is never scanned.
 *
 * Paused is NULL in every case: an unscanned row cannot fire, so pausing needs
 * no second mechanism.
 */
function resolveScheduleInputs(
  scheduleCron: string | null,
  scheduleTimezone: string,
  dueAt: Date | null,
  enabled: boolean,
): { nextRunAt: Date | null } {
  if (scheduleCron) {
    validateCron(scheduleCron, scheduleTimezone, minIntervalMinutesFromEnv())
    return { nextRunAt: computeNextRunAt(scheduleCron, scheduleTimezone, enabled) }
  }
  if (dueAt) {
    validateDueAt(dueAt)
    return { nextRunAt: enabled ? dueAt : null }
  }
  return { nextRunAt: null }
}

/**
 * The trigger a definition has once its schedule columns are known.
 *
 * A cron wins over a due date — the write boundary already refuses both, so
 * reaching here with both is an invariant break, and picking the recurring
 * reading keeps it away from `task_definitions_due_only_when_once`.
 */
function triggerFor(scheduleCron: string | null, dueAt: Date | null): DefinitionTrigger {
  if (scheduleCron) return 'schedule'
  if (dueAt) return 'once'
  return 'manual'
}

/**
 * Whether a `once` definition is a DELEGATION rather than a one-shot somebody
 * scheduled. Both are `trigger = 'once'`; the due date is the whole difference.
 * A delegation is dispatched the moment it is created and belongs to the run
 * list, so the standing-task list filters it out — by this, not by the trigger,
 * or a scheduled one-shot would be invisible in the list that created it.
 */
function isDelegation(definition: TaskDefinition): boolean {
  return definition.trigger === 'once' && definition.dueAt === null
}

/**
 * Permissions attach to the TRIGGER (the decision in the follow-up plan):
 * creating or editing work is `project:edit`; giving it a recurring trigger —
 * unattended, REPEATED spend against somebody's budget — additionally needs
 * `project:skills:manage`. Two calls, not one array, because the two checks
 * have different subjects and this reads as what it is.
 *
 * A one-shot is deliberately NOT recurring here. It spends exactly once, and
 * anybody who may edit the task can already press "Run now" and spend that same
 * once; dating it for Friday moves when, not how much or how often. Gating it
 * like a cron would make the safer choice — schedule it instead of remembering
 * to press the button — the one that needs more rights.
 */
async function requireDefinitionAccess(
  session: AuthorizedSession,
  projectId: string,
  recurring: boolean,
): Promise<void> {
  await requireProjectAccess(session, projectId, 'project:edit')
  if (recurring) {
    await requireProjectAccess(session, projectId, 'project:skills:manage')
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * A project's standing tasks — everything except a delegation.
 *
 * The filter is `isDelegation`, not `trigger !== 'once'`: since 0090 a `once`
 * definition may be a one-shot somebody scheduled for a date, and that belongs
 * in the list it was created from. Only the dateless kind — dispatched at
 * creation from a chat — belongs to the run list instead.
 */
export async function listJobs(
  session: AuthorizedSession,
  projectId: string,
): Promise<{ jobs: JobView[] }> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:view')
  const rows = await repository.listDefinitionsInProject(projectId, session.organizationId)
  return { jobs: rows.filter((row) => !isDelegation(row)).map(toJobView) }
}

export async function getJob(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
): Promise<JobView> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:view')
  const definition = await repository.findDefinition(jobId, session.organizationId)
  if (!definition || definition.projectId !== projectId) throw new NotFoundError('Job not found.')
  return toJobView(definition)
}

export async function createJob(
  session: AuthorizedSession,
  projectId: string,
  input: CreateJobInput,
): Promise<JobView> {
  assertJobsFeatureOn(session)
  const scheduleCron = input.scheduleCron ?? null
  const dueAt = input.dueAt ?? null
  await requireDefinitionAccess(session, projectId, scheduleCron !== null)

  const scheduleTimezone = input.scheduleTimezone ?? 'UTC'
  const enabled = input.enabled ?? true
  const attached = await resolveAttachedSkill(input.skillName, session.organizationId)
  const { nextRunAt } = resolveScheduleInputs(scheduleCron, scheduleTimezone, dueAt, enabled)

  const definition = await repository.insertDefinition({
    projectId,
    organizationId: session.organizationId,
    kind: input.output,
    title: input.name,
    plan: {
      prompt: input.prompt,
      skill: attached.skillSnapshot,
      // knowledge_layer is always included; the stored list is "additional sources".
      dataSources: withAlwaysOnSources(input.dataSources ?? null),
    },
    requesterUserId: session.userId,
    requesterEmail: session.email,
    trigger: triggerFor(scheduleCron, dueAt),
    enabled,
    scheduleCron,
    scheduleTimezone,
    dueAt,
    nextRunAt,
  })
  return toJobView(definition)
}

export async function updateJob(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
  patch: PatchJobInput,
): Promise<JobView> {
  assertJobsFeatureOn(session)
  const existing = await repository.findDefinition(jobId, session.organizationId)
  if (!existing || existing.projectId !== projectId) throw new NotFoundError('Job not found.')

  const scheduleCron = patch.scheduleCron !== undefined ? patch.scheduleCron : existing.scheduleCron
  // `undefined` keeps what the row has, an explicit `null` clears it — the same
  // absent-vs-null contract `scheduleCron` above and `skillName` below follow.
  // Without it, editing a one-shot's prompt would silently drop its due date
  // and turn the task into a manual one.
  const dueAt = patch.dueAt !== undefined ? patch.dueAt : existing.dueAt
  // Turning a definition INTO a recurring one is the permissioned act; editing
  // an existing schedule's prompt is not. A patch that pins a cron (or keeps
  // one) therefore asks for the stricter permission exactly when the RESULT is
  // recurring.
  await requireDefinitionAccess(session, projectId, scheduleCron !== null)

  const scheduleTimezone = patch.scheduleTimezone ?? existing.scheduleTimezone
  const enabled = patch.enabled ?? existing.enabled
  // A cron and a due date cannot coexist (the write boundary refuses both), so
  // pinning one clears the other here rather than leaving a stale value for the
  // CHECK constraint to reject as a 500.
  const effectiveDueAt = scheduleCron ? null : dueAt
  const { nextRunAt } = resolveScheduleInputs(
    scheduleCron,
    scheduleTimezone,
    effectiveDueAt,
    enabled,
  )

  let plan = existing.plan
  if (patch.name !== undefined || patch.prompt !== undefined || patch.skillName !== undefined || patch.dataSources !== undefined) {
    const attached =
      patch.skillName === undefined
        ? { skillSnapshot: plan.skill }
        : await resolveAttachedSkill(patch.skillName, session.organizationId)
    plan = {
      ...plan,
      prompt: patch.prompt ?? plan.prompt,
      skill: attached.skillSnapshot,
      dataSources:
        patch.dataSources !== undefined
          ? withAlwaysOnSources(patch.dataSources)
          : plan.dataSources,
    }
  }

  const definition = await repository.updateDefinition(jobId, session.organizationId, {
    title: patch.name,
    plan,
    trigger: triggerFor(scheduleCron, effectiveDueAt),
    enabled,
    scheduleCron,
    scheduleTimezone,
    dueAt: effectiveDueAt,
    nextRunAt,
    updatedAt: new Date(),
  })
  if (!definition) throw new NotFoundError('Job not found.')
  return toJobView(definition)
}

export async function deleteJob(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
): Promise<{ deleted: true }> {
  assertJobsFeatureOn(session)
  const existing = await repository.findDefinition(jobId, session.organizationId)
  if (!existing || existing.projectId !== projectId) throw new NotFoundError('Job not found.')
  await requireDefinitionAccess(session, projectId, existing.scheduleCron !== null)

  await repository.deleteDefinition(jobId, session.organizationId)
  return { deleted: true }
}

export async function listJobRuns(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
  limit: number,
  offset: number,
): Promise<{ runs: JobRunView[] }> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:view')

  const definition = await repository.findDefinition(jobId, session.organizationId)
  if (!definition || definition.projectId !== projectId) throw new NotFoundError('Job not found.')
  const runs = await repository.listRunsForDefinition(jobId, session.organizationId, { limit, offset })
  return { runs: runs.map(toJobRunView) }
}

// ---------------------------------------------------------------------------
// Fire path (manual + scheduler share it)
// ---------------------------------------------------------------------------

/** Manual "Run now": fires an enabled definition with the caller's identity. */
export async function runJobNow(
  session: AuthorizedSession,
  projectId: string,
  jobId: string,
): Promise<TaskRun> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:skills:manage')

  const definition = await repository.findDefinition(jobId, session.organizationId)
  if (!definition || definition.projectId !== projectId) throw new NotFoundError('Job not found.')
  if (!definition.enabled) throw new ConflictError('This job is disabled.')
  return fireJob(definition, 'manual', session.userId)
}

/** What `buildFirePrompt` needs. The prompt, and since ADR-0060 nothing else. */
export interface FirePromptInput {
  prompt: string
}

/**
 * The deterministic prompt a run is submitted with: the definition's prompt,
 * exactly as a person would have typed it into a new chat.
 *
 * It used to append the attached skill's whole body under the sentence
 * „Verwende dabei den folgenden Skill VERBINDLICH und vollständig." — forcing,
 * written out in German, in the one place a person was least likely to look.
 * A job could therefore impose a skill on a turn, which ADR-0060 says nothing
 * may do, "not the request, not the deployment, not a job", and which
 * `docs/architecture/agent-skills.md` already claimed jobs did not.
 *
 * A job that should run a playbook NAMES it in its prompt, with the same `/`
 * the chat composer has. The model reads the name among the words and decides,
 * the same decision it makes about every other skill in its catalog. That is
 * one mechanism instead of two, and it is the one that cannot lie about who
 * chose.
 */
export function buildFirePrompt({ prompt }: FirePromptInput): string {
  return prompt.trim()
}

/**
 * One background run, as everything below the definition row needs it.
 * Delegated work reaches the same submission through `submitAgentRun` too —
 * it is the submission, not a second queue.
 */
export interface AgentRunSpec {
  organizationId: string
  projectId: string
  /** Whose identity the run carries — pinned, never `'scheduler'`. */
  userId: string
  ownerEmail: string | null
  /**
   * What the run's block in the thread is headed with: the definition's title
   * or the delegated task's. Null when the caller has none; the block then
   * shows its own word for an untitled run.
   */
  title: string | null
  /** The prompt exactly as it is submitted, skill body and decisions included. */
  prompt: string
  /** The attached skill, or null for a plain prompt. */
  skillSnapshot: SkillSnapshot | null
  output: JobOutput
  dataSources: string[] | null
  /**
   * The `task_runs` row this submission is for, minted by the caller BEFORE the
   * submission because the run's message id is derived from it.
   */
  runId: string
  /**
   * The thread the work was commissioned in — the conversation a person was
   * typing in, or the standing task's own thread — and the place this run's
   * message goes. Null when there is nowhere to write: the run still runs, it
   * just has no account of itself in any thread (ADR-0062).
   */
  conversationId: string | null
}

/**
 * What the submission produced: the backend's id, where the answer lands, and
 * the message the run writes into.
 */
export interface SubmittedAgentRun {
  backendJobId: string
  conversationId: string | null
  /** Null when the thread is unknown or the message could not be minted. */
  runMessageId: string | null
}

/**
 * Build one run's context, submit it to the backend, and give the run its place
 * in the thread. Throws what `submitJob` throws (`JobSubmitError`,
 * `JobSubmitSkippedError`) and whatever a context lookup throws; every caller
 * records that on a run row, because a fire that never reached the agent is
 * still an attempt a person can see.
 *
 * The run's message is minted AFTER the backend accepted the submission, and
 * that order is the point: a fire the agent refused (an org cap, an unreachable
 * queue) leaves no empty assistant bubble in somebody's thread. Before this, the
 * same fire left a whole empty conversation behind.
 */
export async function submitAgentRun(spec: AgentRunSpec): Promise<SubmittedAgentRun> {
  const { organizationId, projectId, userId } = spec
  const [
    budgetSnapshot,
    modelOverrides,
    collectionScope,
    projectContext,
    bundesland,
    projectMemory,
    memoryReflectionEnabled,
    orgInstructions,
  ] = await Promise.all([
    resolveBudgetSnapshot(organizationId, userId, projectId),
    getEffectiveModelOverrides(organizationId).catch(() => null),
    buildProjectCollectionScope(projectId, organizationId),
    loadProjectPromptView(projectId, organizationId).catch(() => null),
    loadProjectBundesland(projectId, organizationId).catch(() => null),
    buildProjectMemoryDigest(projectId, organizationId, { query: spec.prompt }).catch(() => null),
    isMemoryReflectionEnabled(organizationId).catch(() => false),
    // The organization's standing instruction block. A scheduled or delegated
    // run is a turn like any other, so it carries the same preferences a chat
    // turn does — a task that answered in a voice the office had asked against
    // would be the whole point of the block, missed.
    resolveOrgInstructions(organizationId),
  ])
  const budgetHeader = budgetSnapshot ? encodeGridBudgetHeader(budgetSnapshot) : null
  const conversationId = spec.conversationId

  const payload: JobSubmitPayload = {
    input: spec.prompt,
    skills: spec.skillSnapshot ? [spec.skillSnapshot.name] : [],
    output: spec.output,
    ...(conversationId ? { conversation_id: conversationId } : {}),
    // The run this job is, so the worker folds its ledger onto the run's own
    // message instead of narrating into the void (ADR-0062).
    run_id: spec.runId,
    data_sources: withAlwaysOnSources(spec.dataSources ?? null),
    collection_scope: collectionScope,
    project_context: projectContext,
    project_memory: projectMemory,
    memory_reflection_enabled: memoryReflectionEnabled,
    organization_id: organizationId,
    user_id: userId,
    project_id: projectId,
    owner_email: spec.ownerEmail,
    budget_header: budgetHeader,
    model_overrides: modelOverrides,
  }

  const contextHeaders = buildGridRequestContextWireHeaders(
    {
      organizationId,
      userId,
      projectId,
      collectionScope,
      projectContext,
      projectMemory,
      orgInstructions,
      modelOverrides,
      budget: budgetSnapshot,
      bundesland,
      memoryReflectionEnabled,
    },
    process.env.GRID_INTERNAL_API_TOKEN,
  )

  const { jobId } = await submitJob(payload, contextHeaders)
  const runMessageId = conversationId
    ? await mintRunMessage(conversationId, spec.runId, spec.title)
    : null
  return { backendJobId: jobId, conversationId, runMessageId }
}

/**
 * The run's place in the thread, or null.
 *
 * Swallowed like the thread creation below it, and for the same reason: a run
 * whose narration could not be minted is a run that still ran. The worker falls
 * back to writing its report as an ordinary turn when the run has no message
 * (`jobs/conversation_output.py`), so the answer reaches the reader either way —
 * what is lost is the live ledger, not the work.
 */
async function mintRunMessage(
  conversationId: string,
  runId: string,
  title: string | null,
): Promise<string | null> {
  try {
    const message = await createRunMessage(conversationId, runId, { title })
    return message.id
  } catch (err) {
    console.warn('[runs] could not create the run message for run', runId, err)
    return null
  }
}

/**
 * The single submission path (manual + scheduled).
 *
 * Context building sits inside the try: a transient DB/WorkOS failure surfaces
 * as an `error` run row, never as an unrecorded throw — the definition advances
 * past this occurrence regardless. A skip or an error is a `task_runs` row with
 * a terminal status, which is how a failed fire becomes visible in Aufgaben.
 */
export async function fireJob(
  definition: TaskDefinition,
  trigger: TaskRunTrigger,
  actor: string,
): Promise<TaskRun> {
  const { organizationId, projectId } = definition
  // Minted HERE, before anything is submitted, because the run's message id is
  // derived from it (`runMessageId`) and the message is written while the run
  // row is still being assembled. Every outcome below — running, skipped,
  // errored — records this same id, so one fire is one id from end to end.
  const runId = randomUUID()

  try {
    // What earlier runs of this definition were told "no" about, in the
    // reviewer's words, so the rejection reaches the run instead of a log line.
    const decisions = await previousDecisionsBlock(definition)
    const firePrompt = [buildFirePrompt({ prompt: definition.plan.prompt }), decisions]
      .filter(Boolean)
      .join('\n\n')
    // The definition's own thread, created on the first fire and found by id on
    // every later one. A definition fired from here is a STANDING intent — a
    // schedule, or a „Jetzt ausführen" somebody can press again — and its runs
    // belong together in one place rather than in a new conversation per fire.
    const thread = await createTaskThread(definition)
    const { backendJobId, conversationId, runMessageId } = await submitAgentRun({
      organizationId,
      projectId,
      userId: definition.requesterUserId,
      ownerEmail: definition.requesterEmail,
      title: definition.title,
      prompt: firePrompt,
      // Dormant: a legacy row's snapshot is still recorded on the run so the
      // history says what the job was configured with, and the submission's
      // `skills` name list is a log line. Neither puts a body in front of the
      // model any more.
      skillSnapshot: definition.plan.skill.name ? definition.plan.skill : null,
      output: definition.kind === 'deep-research' ? 'deep-research' : 'chat',
      dataSources: definition.plan.dataSources ?? null,
      runId,
      conversationId: thread,
    })
    return recordRun(definition, trigger, actor, runId, {
      status: 'running',
      backendJobId,
      error: null,
      conversationId,
      runMessageId,
      firePrompt,
    })
  } catch (err) {
    if (err instanceof JobSubmitSkippedError) {
      const detail =
        err.retryAfterSeconds != null
          ? `${err.message} (retry after ${err.retryAfterSeconds}s)`
          : err.message
      return recordRun(definition, trigger, actor, runId, {
        status: 'skipped',
        backendJobId: null,
        error: detail,
        conversationId: null,
      })
    }
    const detail =
      err instanceof JobSubmitError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Unexpected error while preparing the run'
    return recordRun(definition, trigger, actor, runId, {
      status: 'error',
      backendJobId: null,
      error: detail,
      conversationId: null,
    })
  }
}

/** What one fire produced, as the row-writer below needs it. */
interface FireOutcome {
  status: 'running' | 'skipped' | 'error'
  backendJobId: string | null
  error: string | null
  conversationId: string | null
  /** The message the run narrates itself in; absent when nothing was submitted. */
  runMessageId?: string | null
  /** Frozen into the run's plan when the submission succeeded. */
  firePrompt?: string
}

/**
 * Record the attempt — created BEFORE the outcome can arrive, with the backend
 * id the worker will report through. `firePrompt` is frozen into the run's plan
 * when submission succeeded; a skipped/error fire records the definition's plan
 * unchanged, because nothing was sent.
 *
 * The id is the caller's, not the column default: the run's message was derived
 * from it before this row existed.
 */
async function recordRun(
  definition: TaskDefinition,
  trigger: TaskRunTrigger,
  actor: string,
  runId: string,
  { status, backendJobId, error, conversationId, runMessageId, firePrompt }: FireOutcome,
): Promise<TaskRun> {
  const run = await repository.insertRun({
    id: runId,
    runMessageId: runMessageId ?? null,
    organizationId: definition.organizationId,
    projectId: definition.projectId,
    definitionId: definition.id,
    kind: definition.kind,
    title: definition.title,
    plan: firePrompt ? { ...definition.plan, prompt: firePrompt } : definition.plan,
    requesterUserId: definition.requesterUserId,
    requesterEmail: definition.requesterEmail,
    trigger,
    triggeredBy: actor,
    status,
    error,
    skillSnapshot: definition.plan.skill.name
      ? definition.plan.skill
      : emptySkillSnapshot(),
    backendJobId,
    conversationId,
    startedAt: status === 'running' ? new Date() : null,
  })
  await repository.touchDefinitionLastRun(definition.id, run.createdAt)
  return run
}

/**
 * The ONE thread a standing task owns — a real conversation the team opens,
 * reads and keeps typing into, not a rendering of a report (ADR-0062).
 *
 * Idempotent: the id is derived from the definition's id
 * (`lib/tasks/task-thread.ts`), so the first fire creates the row and every
 * later one finds it. There is no „does it exist" query and no unique index to
 * add — `conversations`' primary key plus `ON CONFLICT DO NOTHING` is the whole
 * mechanism, and two concurrent fires converge on one row.
 *
 * Returns the thread's id, or null when the insert threw. A delegation calls
 * this only when the person was NOT typing in a thread: work asked for in a
 * conversation belongs in that conversation.
 *
 * The title is the definition's at first fire and is not chased afterwards.
 * Renaming a schedule renames the schedule; the thread keeps the name the team
 * has been reading it under.
 *
 * **`createdBy` is the definition's requester — a real user id, never
 * 'scheduler' and never a synthetic one.** Four separate mechanisms read
 * `conversations.created_by` as a person, and a synthetic id breaks all four:
 * the sharing roster lists the creator as a participant, the last-owner
 * invariant refuses to leave a resource ownerless, `attributeLegacyAuthor`
 * names them as the author of pre-collaboration messages, and
 * `recordAuditEvent` requires an actor with a `userId: string`.
 *
 * **`visibility: 'project'` at creation, not 'private'.** ADR-0032 made
 * `private` the default so that sharing is a DELIBERATE act; this IS that act.
 * Two people following the run-history link would otherwise get a 404.
 *
 * **`jobId` stamps the provenance** — it is what lets the UI render the
 * definition's name and glyph instead of the owner's face, and what keeps the
 * OLD per-fire threads out of the owner's personal chat history. The standing
 * thread carries it too and is shown anyway: `isTaskThread` tells the two apart
 * from the id alone, and a task's one thread is a place the team goes back to.
 *
 * A failure here is logged and swallowed: a scheduled run must still run.
 */
export async function createTaskThread(definition: TaskDefinition): Promise<string | null> {
  const id = taskThreadConversationId(definition.id)

  try {
    // `insertConversation` answers null on an id conflict, which here means the
    // thread is already there — the ordinary case from the second fire onwards.
    // Either way the id is the answer.
    await insertConversation({
      id,
      organizationId: definition.organizationId,
      createdBy: definition.requesterUserId,
      title: `Aufgabe: ${definition.title}`,
      projectId: definition.projectId,
      visibility: 'project',
      jobId: definition.id,
    })
    return id
  } catch (err) {
    console.warn('[definitions] failed to create the thread for definition', definition.id, err)
    return null
  }
}

/** Internal (scheduler) fire: load a definition by id WITHOUT an org filter. */
export async function loadJobForFire(jobId: string): Promise<TaskDefinition | null> {
  return repository.findDefinitionById(jobId)
}

/**
 * The scheduler's gate: disabled definition → `disabled`; with WorkOS flag
 * enforcement the per-org `skills` flag is checked and a failure records a
 * `skipped` run (fail-closed); otherwise the run fires. `fireJob` itself never
 * throws for a skip.
 */
export async function fireScheduledJob(
  definition: TaskDefinition,
): Promise<{ fired: boolean; jobId?: string; reason?: 'disabled' | 'feature-disabled' | 'skipped' | 'error' }> {
  if (!definition.enabled) {
    return { fired: false, reason: 'disabled' }
  }
  if (enforcementOn()) {
    let flagOn = false
    try {
      flagOn = await isOrgFeatureEnabled(SKILLS_FLAG, definition.organizationId)
    } catch {
      flagOn = false
    }
    if (!flagOn) {
      await recordRun(definition, 'schedule', 'scheduler', randomUUID(), {
        status: 'skipped',
        backendJobId: null,
        error: 'Skills feature disabled for organization',
        conversationId: null,
      })
      return { fired: false, reason: 'feature-disabled' }
    }
  }
  const run = await fireJob(definition, 'schedule', 'scheduler')
  if (run.status === 'running') return { fired: true, jobId: run.backendJobId ?? undefined }
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
 * buildCollectionScopeFromRequest produces for a project. Resolved from the
 * project row (session-less path); falls back to the id-derived name if the
 * row is gone.
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
