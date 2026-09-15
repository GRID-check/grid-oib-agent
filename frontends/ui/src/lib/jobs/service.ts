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
import type { JobOutput, TaskDefinition, TaskRun, TaskRunTrigger } from '@/lib/db/schema'
import { resolveSelectableSkills, resolveSkillSnapshot } from '@/lib/skills/service'
import { snapshotOf, type SkillSnapshot } from '@/lib/skills/types'
import { nextOccurrence, validateCron, minIntervalMinutesFromEnv } from './schedule'
import {
  submitJob,
  JobSubmitError,
  JobSubmitSkippedError,
  type JobSubmitPayload,
} from './backend-client'
import * as repository from '@/lib/tasks/repository'
import { previousDecisionsBlock } from '@/lib/tasks/service'
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
 * Validate the cron (shape, timezone, minimum interval) and compute the
 * definition's next occurrence. There is no veto from the attached skill:
 * whether something may run on a timer is a property of the work.
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

/** The trigger a definition has once its schedule columns are known. */
function triggerFor(scheduleCron: string | null): 'manual' | 'schedule' {
  return scheduleCron ? 'schedule' : 'manual'
}

/**
 * Permissions attach to the TRIGGER (the decision in the follow-up plan):
 * creating or editing work is `project:edit`; giving it a recurring trigger —
 * unattended, repeated spend against somebody's budget — additionally needs
 * `project:skills:manage`. Two calls, not one array, because the two checks
 * have different subjects and this reads as what it is.
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
 * A project's definitions as templates: `manual` and `schedule` only. A `once`
 * definition is a delegation and belongs to the run list, not to the recurring
 * picker.
 */
export async function listJobs(
  session: AuthorizedSession,
  projectId: string,
): Promise<{ jobs: JobView[] }> {
  assertJobsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:view')
  const rows = await repository.listDefinitionsInProject(projectId, session.organizationId)
  return { jobs: rows.filter((row) => row.trigger !== 'once').map(toJobView) }
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
  await requireDefinitionAccess(session, projectId, scheduleCron !== null)

  const scheduleTimezone = input.scheduleTimezone ?? 'UTC'
  const enabled = input.enabled ?? true
  const attached = await resolveAttachedSkill(input.skillName, session.organizationId)
  const { nextRunAt } = resolveScheduleInputs(scheduleCron, scheduleTimezone, enabled)

  const definition = await repository.insertDefinition({
    projectId,
    organizationId: session.organizationId,
    kind: input.output,
    title: input.name,
    plan: {
      prompt: input.prompt,
      skill: attached.skillSnapshot,
      // knowledge_layer is always included; the stored list is "additional sources".
      dataSources: withAlwaysOnKnowledge(input.dataSources ?? null),
    },
    requesterUserId: session.userId,
    requesterEmail: session.email,
    trigger: triggerFor(scheduleCron),
    enabled,
    scheduleCron,
    scheduleTimezone,
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
  // Turning a definition INTO a recurring one is the permissioned act; editing
  // an existing schedule's prompt is not. A patch that pins a cron (or keeps
  // one) therefore asks for the stricter permission exactly when the RESULT is
  // recurring.
  await requireDefinitionAccess(session, projectId, scheduleCron !== null)

  const scheduleTimezone = patch.scheduleTimezone ?? existing.scheduleTimezone
  const enabled = patch.enabled ?? existing.enabled
  const { nextRunAt } = resolveScheduleInputs(scheduleCron, scheduleTimezone, enabled)

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
          ? withAlwaysOnKnowledge(patch.dataSources)
          : plan.dataSources,
    }
  }

  const definition = await repository.updateDefinition(jobId, session.organizationId, {
    title: patch.name,
    plan,
    trigger: triggerFor(scheduleCron),
    enabled,
    scheduleCron,
    scheduleTimezone,
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

export async function listAttachableSkills(
  session: AuthorizedSession,
  output: JobOutput,
): Promise<{ skills: AttachableSkill[] }> {
  assertJobsFeatureOn(session)
  const { skills } = await resolveSelectableSkills(session.organizationId, AGENT_FOR_OUTPUT[output])
  return {
    skills: [...skills].sort((left, right) => left.name.localeCompare(right.name)),
  }
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

/** What `buildFirePrompt` needs: the definition's prompt and attached skill. */
export interface FirePromptInput {
  prompt: string
  skill: SkillSnapshot | null
}

/**
 * The deterministic prompt a run is submitted with.
 *
 * The prompt ALWAYS, exactly as a person would have typed it into a new chat,
 * plus the attached skill's full body when there is one. With no skill
 * attached the output is the prompt and nothing else.
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
  /** The prompt exactly as it is submitted, skill body and decisions included. */
  prompt: string
  /** The attached skill, or null for a plain prompt. */
  skillSnapshot: SkillSnapshot | null
  output: JobOutput
  dataSources: string[] | null
  /**
   * The title of the conversation an `output: 'chat'` run writes into. Null
   * means "no conversation": a deep-research run produces a report.
   */
  conversationTitle: string | null
  /** Stamped on the conversation when the run belongs to a definition. */
  jobId?: string | null
}

/** What the submission produced: the backend's id and where the answer lands. */
export interface SubmittedAgentRun {
  backendJobId: string
  conversationId: string | null
}

/**
 * Build one run's context, create its conversation and submit it to the
 * backend. Throws what `submitJob` throws (`JobSubmitError`,
 * `JobSubmitSkippedError`) and whatever a context lookup throws; every caller
 * records that on a run row, because a fire that never reached the agent is
 * still an attempt a person can see.
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

  const conversationId =
    spec.output === 'chat' && spec.conversationTitle
      ? await createRunConversation({
          organizationId,
          projectId,
          createdBy: userId,
          title: spec.conversationTitle,
          jobId: spec.jobId ?? null,
        })
      : null

  const payload: JobSubmitPayload = {
    input: spec.prompt,
    skills: spec.skillSnapshot ? [spec.skillSnapshot.name] : [],
    output: spec.output,
    ...(conversationId ? { conversation_id: conversationId } : {}),
    data_sources: withAlwaysOnKnowledge(spec.dataSources ?? null),
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
  return { backendJobId: jobId, conversationId }
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

  try {
    // What earlier runs of this definition were told "no" about, in the
    // reviewer's words, so the rejection reaches the run instead of a log line.
    const decisions = await previousDecisionsBlock(definition)
    const skill = definition.plan.skill.name ? definition.plan.skill : null
    const firePrompt = [
      buildFirePrompt({ prompt: definition.plan.prompt, skill }),
      decisions,
    ]
      .filter(Boolean)
      .join('\n\n')
    const { backendJobId, conversationId } = await submitAgentRun({
      organizationId,
      projectId,
      userId: definition.requesterUserId,
      ownerEmail: definition.requesterEmail,
      prompt: firePrompt,
      skillSnapshot: skill,
      output: definition.kind === 'deep-research' ? 'deep-research' : 'chat',
      dataSources: definition.plan.dataSources ?? null,
      conversationTitle: definition.title,
      jobId: definition.id,
    })
    return recordRun(definition, trigger, actor, 'running', backendJobId, null, conversationId, firePrompt)
  } catch (err) {
    if (err instanceof JobSubmitSkippedError) {
      const detail =
        err.retryAfterSeconds != null
          ? `${err.message} (retry after ${err.retryAfterSeconds}s)`
          : err.message
      return recordRun(definition, trigger, actor, 'skipped', null, detail, null)
    }
    if (err instanceof JobSubmitError) {
      return recordRun(definition, trigger, actor, 'error', null, err.message, null)
    }
    const detail = err instanceof Error ? err.message : 'Unexpected error while preparing the run'
    return recordRun(definition, trigger, actor, 'error', null, detail, null)
  }
}

/**
 * Record the attempt — created BEFORE the outcome can arrive, with the backend
 * id the worker will report through. `firePrompt` is frozen into the run's plan
 * when submission succeeded; a skipped/error fire records the definition's plan
 * unchanged, because nothing was sent.
 */
async function recordRun(
  definition: TaskDefinition,
  trigger: TaskRunTrigger,
  actor: string,
  status: 'running' | 'skipped' | 'error',
  backendJobId: string | null,
  error: string | null,
  conversationId: string | null,
  firePrompt?: string,
): Promise<TaskRun> {
  const run = await repository.insertRun({
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
 * The conversation an `output: 'chat'` run writes into — a real thread the team
 * opens, reads and keeps typing into, not a rendering of a report.
 *
 * Returns the new conversation's id, or null when the insert failed. Whether a
 * run HAS a conversation is the caller's decision, because a delegated task
 * decides it from its kind rather than from a definition row.
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
 * definition's name and glyph instead of the owner's face, and what keeps
 * these threads out of the owner's personal chat history.
 *
 * A failure here is logged and swallowed: a scheduled run must still run.
 */
async function createRunConversation(run: {
  organizationId: string
  projectId: string
  createdBy: string
  title: string
  /** Null for a delegated task, which still stamps the once definition's id. */
  jobId: string | null
}): Promise<string | null> {
  // The app's conversation id shape: `s_` + a uuid with hyphens as underscores.
  // It doubles as this session's Qdrant collection name, so a definition
  // conversation must be minted exactly the way an interactive one is.
  const id = `s_${randomUUID().replace(/-/g, '_')}`

  try {
    const inserted = await insertConversation({
      id,
      organizationId: run.organizationId,
      createdBy: run.createdBy,
      title: run.title,
      projectId: run.projectId,
      visibility: 'project',
      jobId: run.jobId,
    })
    if (inserted) return inserted.id
    console.warn('[definitions] conversation id collision while firing run', run.jobId ?? run.title)
    return null
  } catch (err) {
    console.warn('[definitions] failed to create the conversation for run', run.jobId ?? run.title, err)
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
      await recordRun(
        definition,
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
