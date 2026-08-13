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
import { computeCollectionScope } from '@/lib/collection-scope'
import {
  buildGridRequestContextWireHeaders,
  encodeGridBudgetHeader,
  type GridBudgetSnapshot,
} from '@/lib/request-context'
import { isOrgFeatureEnabled, SKILLS_FLAG } from '@/lib/workos/feature-flags'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Job, JobOutput, JobRun, JobRunStatus, JobRunTrigger } from '@/lib/db/schema'
import { resolveSelectableSkills, resolveSkillSnapshot } from '@/lib/skills/service'
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
 *
 * `resolveSelectableSkills`, not `resolveSkillsForAgent`: the platform's
 * standard skills resolve for this organization on every run, but they are not
 * the org's to attach. Offering one here would build a job around an instruction
 * whose body this tenant cannot read in the preview pane, cannot edit, and
 * cannot keep — `resolveSkillSnapshot` refuses the name, so the save would 404
 * on something the picker had just shown as available.
 */
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

    // An `output: 'chat'` run lands in a REAL conversation the team can open
    // and continue, and this is where it is created — before submission,
    // because the backend needs its id to write into (see the payload below).
    const conversationId = await createRunConversation(job)

    const payload: JobSubmitPayload = {
      input: buildFirePrompt({ prompt: job.prompt, skill: job.skillSnapshot }),
      // Empty when no skill is attached: the prompt runs alone, which the
      // backend now accepts.
      skills: job.skillSnapshot ? [job.skillSnapshot.name] : [],
      output: job.output,
      // Where the answer is to be written. Absent for deep-research (a report,
      // not a thread) and for a chat run whose conversation could not be
      // created — the backend then behaves exactly as it did before jobs had
      // conversations at all.
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

/**
 * The conversation an `output: 'chat'` run writes into — a real thread the team
 * opens, reads and keeps typing into, not a rendering of a report.
 *
 * Returns the new conversation's id, or null when this job produces no
 * conversation (`output: 'deep-research'`) or when the insert failed.
 *
 * Three decisions are made here, and each was forced:
 *
 * **`createdBy` is the JOB'S OWNER — a real user id, never 'scheduler' and
 * never a synthetic one.** Four separate mechanisms read `conversations.created_by`
 * as a person, and a synthetic id breaks all four: the sharing roster lists the
 * creator as a participant (`lib/sharing/service.ts`), the last-owner invariant
 * refuses to leave a resource ownerless and needs a real user to hold that role,
 * `attributeLegacyAuthor` names them as the author of pre-collaboration
 * messages, and `recordAuditEvent` requires an actor with a `userId: string`.
 * A conversation owned by nobody is one nobody can act as, that notifies nobody
 * (participants = {createdBy} ∪ {grantees}), and that cannot be audited. The
 * owner is also the identity the run itself already carries — `user_id` on the
 * payload and in the signed context envelope — so this adds no new attribution,
 * it just stops the conversation from disagreeing with the run.
 *
 * **`visibility: 'project'` at creation, not 'private'.** ADR-0032 made
 * `private` the default so that sharing is a DELIBERATE act; this IS that act,
 * made at schedule time. Someone holding `project:skills:manage` set up a
 * recurring job on a project, whose runs are already readable by anyone with
 * `project:view` — a thread that only its nominal owner can open would hide the
 * output of a team artefact behind one person's account, and every colleague
 * following the run-history link would get a 404. The interactive path still
 * passes no visibility at all and still gets `private` from the column default.
 *
 * **`jobId` stamps the provenance** (migration 0044): it is what lets the UI
 * render the job's name and glyph instead of the owner's face, and what keeps
 * these threads out of the owner's personal chat history — a weekly job is 52
 * of them a year.
 *
 * A failure here is logged and swallowed: a scheduled run must still run. The
 * run then submits with no `conversation_id` and its `job_runs` row records
 * none, which is exactly the shape of every run that predates this feature.
 * The reverse trade — refusing to fire because a row could not be written — is
 * the one outcome nobody would want at 03:00.
 *
 * Note what is deliberately NOT done: when submission subsequently fails, the
 * conversation created here is left in place rather than cleaned up. A submit
 * error is not proof the backend did not receive the run (a timeout is the
 * common case), and deleting the conversation a run is about to write into
 * would destroy the output to tidy up a row.
 */
async function createRunConversation(job: Job): Promise<string | null> {
  if (job.output !== 'chat') return null

  // The app's conversation id shape: `s_` + a uuid with hyphens as underscores.
  // It is not cosmetic — the id doubles as this session's Qdrant collection
  // name (`lib/collection-scope.ts`, `lib/proxy/collection-authz.ts` both key
  // off the `s_` prefix), so a job conversation must be minted exactly the way
  // `features/chat/stores/sessions-store.ts` mints an interactive one.
  const id = `s_${randomUUID().replace(/-/g, '_')}`

  try {
    const inserted = await insertConversation({
      id,
      organizationId: job.organizationId,
      createdBy: job.createdBy,
      title: job.name,
      projectId: job.projectId,
      visibility: 'project',
      jobId: job.id,
    })
    if (inserted) return inserted.id
    // `onConflictDoNothing` returned nothing, i.e. the id already exists —
    // impossible for a uuid we just minted, so treat it as a failed create
    // rather than adopting a row we cannot vouch for.
    console.warn('[jobs] conversation id collision while firing job', job.id)
    return null
  } catch (err) {
    console.warn('[jobs] failed to create the conversation for job', job.id, err)
    return null
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
