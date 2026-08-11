/**
 * Agent Skills domain service (Phase A) — org toolbox + project schedules.
 *
 * Responsibilities (ADR-0017): authorization (feature gate, project access,
 * org skill management), business rules (reserved metadata, cron validation,
 * snapshot semantics, single fire path), and run recording. The service NEVER
 * returns raw error statuses; it throws typed errors from `@/lib/api/errors`.
 *
 * Fire-path tenancy: `fireSkillSchedule` derives tenancy from the schedule row
 * itself and never throws for a skip — the manual "Run now" route and the
 * internal (scheduler) fire route share it.
 */

import 'server-only'
import { requireProjectAccess } from '@/lib/authz/projects'
import { canManageSkills } from '@/lib/authz/organizations'
import { enforcementOn, requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getBudgetStatus } from '@/lib/budgets/service'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import {
  loadProjectBundesland,
  loadProjectPromptView,
} from '@/lib/project-profile/prompt-view'
import { computeCollectionScope } from '@/lib/collection-scope'
import {
  buildGridRequestContextWireHeaders,
  encodeGridBudgetHeader,
  type GridBudgetSnapshot,
} from '@/lib/request-context'
import { isOrgFeatureEnabled, SKILLS_FLAG } from '@/lib/workos/feature-flags'
import type { AuthorizedSession } from '@/lib/auth/types'
import type {
  Skill,
  SkillExecution,
  SkillOrigin,
  SkillRun,
  SkillRunStatus,
  SkillRunTrigger,
  SkillSchedule,
} from '@/lib/db/schema'
import { nextOccurrence, validateCron, minIntervalMinutesFromEnv } from './schedule'
import {
  submitSkillJob,
  SkillSubmitError,
  SkillSubmitSkippedError,
  type SkillSubmitPayload,
} from './backend-client'
import * as repository from './repository'
import {
  executionOf,
  isSchedulable,
  snapshotOf,
  withAlwaysOnKnowledge,
  KNOWN_SKILL_AGENTS,
  METADATA_AGENTS,
  METADATA_EXECUTION,
  type CreateSkillInput,
  type CreateSkillScheduleInput,
  type PatchSkillInput,
  type PatchSkillScheduleInput,
  type SkillSnapshot,
} from './types'
import { findPlatformSkill, listPlatformSkills } from './platform-skills'

// ---------------------------------------------------------------------------
// Feature gate + authorization helpers
// ---------------------------------------------------------------------------

/** Every session-facing call gates on the skills feature (routes do the same). */
function assertSkillsFeatureOn(session: AuthorizedSession): void {
  if (requireSkillsEnabled(session)) {
    throw new ForbiddenError('Agent Skills is disabled.')
  }
}

// ---------------------------------------------------------------------------
// Org toolbox (skills)
// ---------------------------------------------------------------------------

/**
 * A merged toolbox row. Org rows carry their id; builtin platform entries have
 * no DB row yet (id null) and are always enabled.
 */
export type SkillListItem = {
  id: string | null
  name: string
  description: string
  /** Full instruction body — the schedule builder's WYSIWYG preview needs it. */
  body: string
  metadata: Record<string, string>
  origin: SkillOrigin | 'platform'
  enabled: boolean
  clonedFrom: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

function platformToListItem(platform: ReturnType<typeof listPlatformSkills>[number]): SkillListItem {
  return {
    id: null,
    name: platform.name,
    description: platform.description,
    body: platform.body,
    metadata: {},
    origin: 'platform',
    enabled: true,
    clonedFrom: null,
    createdAt: null,
    updatedAt: null,
  }
}

function orgToListItem(skill: Skill): SkillListItem {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    metadata: { ...skill.metadata },
    origin: skill.origin,
    enabled: skill.enabled,
    clonedFrom: skill.clonedFrom,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}

/**
 * The merged toolbox list: every platform builtin PLUS every org row, org rows
 * shadowing platform entries of the same name. Any member may read.
 */
export async function listSkills(session: AuthorizedSession): Promise<{ skills: SkillListItem[] }> {
  assertSkillsFeatureOn(session)
  const rows = await repository.listSkillsInOrg(session.organizationId)
  const byName = new Map<string, SkillListItem>()
  for (const platform of listPlatformSkills()) {
    byName.set(platform.name, platformToListItem(platform))
  }
  for (const row of rows) {
    byName.set(row.name, orgToListItem(row))
  }
  return { skills: [...byName.values()] }
}

/**
 * Author a skill in the org toolbox. `org:skills:manage` required. The
 * `grid-execution` reserved value is validated here (write-time, deterministic
 * — `executionOf`), overriding a `clonedFrom` hint records a platform clone.
 */
export async function createSkill(
  session: AuthorizedSession,
  input: CreateSkillInput,
): Promise<{ skill: Skill }> {
  assertSkillsFeatureOn(session)
  if (!canManageSkills(session)) throw new ForbiddenError('You need org skills management rights.')

  // Deterministic validation of reserved metadata at the write boundary.
  executionOf(input.metadata ?? {})

  const existing = await repository.findSkillByName(input.name, session.organizationId)
  if (existing) {
    throw new ConflictError(`A skill named "${input.name}" already exists in this organization.`)
  }

  const skill = await repository.insertSkill({
    organizationId: session.organizationId,
    name: input.name,
    description: input.description,
    body: input.body,
    metadata: input.metadata ?? {},
    origin: input.clonedFrom ? 'platform-clone' : 'org',
    clonedFrom: input.clonedFrom ?? null,
    enabled: input.enabled ?? true,
    createdBy: session.userId,
    createdByEmail: session.email,
  })
  return { skill }
}

export async function updateSkill(
  session: AuthorizedSession,
  skillId: string,
  patch: PatchSkillInput,
): Promise<{ skill: Skill }> {
  assertSkillsFeatureOn(session)
  if (!canManageSkills(session)) throw new ForbiddenError('You need org skills management rights.')

  const existing = await repository.findSkill(skillId, session.organizationId)
  if (!existing) throw new NotFoundError('Skill not found.')

  if (patch.metadata !== undefined) executionOf(patch.metadata)
  if (patch.name !== undefined && patch.name !== existing.name) {
    const other = await repository.findSkillByName(patch.name, session.organizationId)
    if (other) throw new ConflictError(`A skill named "${patch.name}" already exists in this organization.`)
  }

  const skill = await repository.updateSkill(skillId, session.organizationId, {
    ...patch,
    updatedAt: new Date(),
  })
  if (!skill) throw new NotFoundError('Skill not found.')
  return { skill }
}

export async function deleteSkill(
  session: AuthorizedSession,
  skillId: string,
): Promise<{ deleted: true }> {
  assertSkillsFeatureOn(session)
  if (!canManageSkills(session)) throw new ForbiddenError('You need org skills management rights.')

  const existing = await repository.findSkill(skillId, session.organizationId)
  if (!existing) throw new NotFoundError('Skill not found.')
  await repository.deleteSkill(skillId, session.organizationId)
  return { deleted: true }
}

// ---------------------------------------------------------------------------
// Project schedules
// ---------------------------------------------------------------------------

/** Org row first, builtin platform fallback; unknown names 404. */
async function resolveSkillSnapshot(
  name: string,
  organizationId: string,
): Promise<SkillSnapshot> {
  const orgSkill = await repository.findSkillByName(name, organizationId)
  if (orgSkill) {
    return {
      name: orgSkill.name,
      description: orgSkill.description,
      body: orgSkill.body,
      metadata: { ...orgSkill.metadata },
      origin: orgSkill.origin,
    }
  }
  const platform = findPlatformSkill(name)
  if (platform) {
    return {
      name: platform.name,
      description: platform.description,
      body: platform.body,
      metadata: {},
      origin: 'platform',
    }
  }
  throw new NotFoundError(`Unknown skill "${name}".`)
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

/** Cron writes are vetoed for skills that opted out via grid-schedulable=false. */
function assertSchedulable(snapshot: SkillSnapshot): void {
  if (!isSchedulable(snapshot.metadata)) {
    throw new BadRequestError(
      `Skill "${snapshot.name}" is marked as not schedulable (grid-schedulable=false).`,
    )
  }
}

/**
 * Resolve + validate the scheduling inputs shared by create/update:
 * snapshot, deterministic execution mode, and next_run_at.
 */
async function resolveScheduleInputs(
  skillName: string,
  scheduleCron: string | null,
  scheduleTimezone: string,
  organizationId: string,
  enabled: boolean,
): Promise<{ snapshot: SkillSnapshot; execution: SkillExecution; nextRunAt: Date | null }> {
  const snapshot = await resolveSkillSnapshot(skillName, organizationId)
  const execution = executionOf(snapshot.metadata)
  if (scheduleCron) {
    validateCron(scheduleCron, scheduleTimezone, minIntervalMinutesFromEnv())
  }
  if (scheduleCron && enabled) {
    // Reporter asked for conflict semantics on disabled skills; a skill that
    // opts out of scheduling entirely is a hard BadRequest, not a conflict.
    assertSchedulable(snapshot)
  }
  return { snapshot, execution, nextRunAt: computeNextRunAt(scheduleCron, scheduleTimezone, enabled) }
}

export async function listSkillSchedules(
  session: AuthorizedSession,
  projectId: string,
): Promise<{ schedules: SkillSchedule[] }> {
  assertSkillsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:view')
  const schedules = await repository.listSkillSchedulesInProject(projectId, session.organizationId)
  return { schedules }
}

export async function getSkillSchedule(
  session: AuthorizedSession,
  projectId: string,
  scheduleId: string,
): Promise<SkillSchedule> {
  assertSkillsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:view')
  const schedule = await repository.findSkillSchedule(scheduleId, session.organizationId)
  if (!schedule || schedule.projectId !== projectId) throw new NotFoundError('Schedule not found.')
  return schedule
}

export async function createSkillSchedule(
  session: AuthorizedSession,
  projectId: string,
  input: CreateSkillScheduleInput,
): Promise<SkillSchedule> {
  assertSkillsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:skills:manage')

  const scheduleCron = input.scheduleCron ?? null
  const scheduleTimezone = input.scheduleTimezone ?? 'UTC'
  const enabled = input.enabled ?? true
  const { snapshot, execution, nextRunAt } = await resolveScheduleInputs(
    input.skillName,
    scheduleCron,
    scheduleTimezone,
    session.organizationId,
    enabled,
  )

  return repository.insertSkillSchedule({
    projectId,
    organizationId: session.organizationId,
    name: input.name,
    skillName: snapshot.name,
    skillSnapshot: snapshotOf(snapshot),
    execution,
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

export async function updateSkillSchedule(
  session: AuthorizedSession,
  projectId: string,
  scheduleId: string,
  patch: PatchSkillScheduleInput,
): Promise<SkillSchedule> {
  assertSkillsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:skills:manage')

  const existing = await repository.findSkillSchedule(scheduleId, session.organizationId)
  if (!existing || existing.projectId !== projectId) throw new NotFoundError('Schedule not found.')

  const skillName = patch.skillName ?? existing.skillName
  const scheduleCron = patch.scheduleCron !== undefined ? patch.scheduleCron : existing.scheduleCron
  const scheduleTimezone = patch.scheduleTimezone ?? existing.scheduleTimezone
  const enabled = patch.enabled ?? existing.enabled
  const { snapshot, execution, nextRunAt } = await resolveScheduleInputs(
    skillName,
    scheduleCron,
    scheduleTimezone,
    session.organizationId,
    enabled,
  )

  const schedule = await repository.updateSkillSchedule(scheduleId, session.organizationId, {
    name: patch.name,
    skillName: skillName,
    skillSnapshot: snapshotOf(snapshot),
    execution: execution,
    dataSources: patch.dataSources !== undefined ? withAlwaysOnKnowledge(patch.dataSources) : undefined,
    enabled: enabled,
    scheduleCron: scheduleCron,
    scheduleTimezone: scheduleTimezone,
    nextRunAt: nextRunAt,
    updatedAt: new Date(),
  })
  if (!schedule) throw new NotFoundError('Schedule not found.')
  return schedule
}

export async function deleteSkillSchedule(
  session: AuthorizedSession,
  projectId: string,
  scheduleId: string,
): Promise<{ deleted: true }> {
  assertSkillsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:skills:manage')

  const existing = await repository.findSkillSchedule(scheduleId, session.organizationId)
  if (!existing || existing.projectId !== projectId) throw new NotFoundError('Schedule not found.')
  await repository.deleteSkillSchedule(scheduleId, session.organizationId)
  return { deleted: true }
}

export async function listSkillRunsForSchedule(
  session: AuthorizedSession,
  projectId: string,
  scheduleId: string,
  limit: number,
  offset: number,
): Promise<{ runs: SkillRun[] }> {
  assertSkillsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:view')

  const schedule = await repository.findSkillSchedule(scheduleId, session.organizationId)
  if (!schedule || schedule.projectId !== projectId) throw new NotFoundError('Schedule not found.')
  const runs = await repository.listSkillRuns(scheduleId, session.organizationId, { limit, offset })
  return { runs }
}

// ---------------------------------------------------------------------------
// Fire path (manual + scheduler share it)
// ---------------------------------------------------------------------------

/** Manual "Run now": fires an enabled schedule with the caller's identity. */
export async function runSkillScheduleNow(
  session: AuthorizedSession,
  projectId: string,
  scheduleId: string,
): Promise<SkillRun> {
  assertSkillsFeatureOn(session)
  await requireProjectAccess(session, projectId, 'project:skills:manage')

  const schedule = await repository.findSkillSchedule(scheduleId, session.organizationId)
  if (!schedule || schedule.projectId !== projectId) throw new NotFoundError('Schedule not found.')
  if (!schedule.enabled) throw new ConflictError('This schedule is disabled.')
  return fireSkillSchedule(schedule, 'manual', session.userId)
}

/** The deterministic prompt embedding the snapshot's full body. */
export function buildFirePrompt(snapshot: SkillSnapshot): string {
  return [
    'Führe den folgenden Skill verbindlich und vollständig aus.',
    '',
    '---',
    '',
    `Skill: ${snapshot.name}`,
    `Beschreibung: ${snapshot.description}`,
    '',
    snapshot.body,
    '---',
  ].join('\n')
}

/**
 * The single submission path (manual + scheduled). Context building sits
 * inside the try: a transient DB/WorkOS failure surfaces as an `error` run
 * row, never as an unrecorded throw — the schedule advances past this
 * occurrence regardless.
 */
export async function fireSkillSchedule(
  schedule: SkillSchedule,
  trigger: SkillRunTrigger,
  actor: string,
): Promise<SkillRun> {
  const { organizationId, projectId, createdBy } = schedule

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

    const payload: SkillSubmitPayload = {
      input: buildFirePrompt(schedule.skillSnapshot),
      skills: [schedule.skillSnapshot.name],
      execution: schedule.execution,
      // Defense for legacy rows persisted before knowledge_layer was always-on.
      data_sources: withAlwaysOnKnowledge(schedule.dataSources ?? null),
      collection_scope: collectionScope,
      project_context: projectContext,
      organization_id: organizationId,
      user_id: createdBy,
      project_id: projectId,
      owner_email: schedule.createdByEmail,
      budget_header: budgetHeader,
      model_overrides: modelOverrides,
    }

    // Signed context envelope (same wire format as fireWorkflow): built from
    // the exact values above via the shared GridRequestContext builder so the
    // skill path's wire format can never drift from the interactive one.
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

    const { jobId } = await submitSkillJob(payload, contextHeaders)
    return recordSkillRun(schedule, trigger, actor, 'submitted', jobId, null)
  } catch (err) {
    if (err instanceof SkillSubmitSkippedError) {
      const detail =
        err.retryAfterSeconds != null
          ? `${err.message} (retry after ${err.retryAfterSeconds}s)`
          : err.message
      return recordSkillRun(schedule, trigger, actor, 'skipped', null, detail)
    }
    if (err instanceof SkillSubmitError) {
      return recordSkillRun(schedule, trigger, actor, 'error', null, err.message)
    }
    const detail = err instanceof Error ? err.message : 'Unexpected error while preparing the run'
    return recordSkillRun(schedule, trigger, actor, 'error', null, detail)
  }
}

async function recordSkillRun(
  schedule: SkillSchedule,
  trigger: SkillRunTrigger,
  actor: string,
  status: SkillRunStatus,
  jobId: string | null,
  detail: string | null,
): Promise<SkillRun> {
  const run = await repository.insertSkillRun({
    scheduleId: schedule.id,
    projectId: schedule.projectId,
    organizationId: schedule.organizationId,
    jobId,
    trigger,
    status,
    detail,
    skillSnapshot: snapshotOf(schedule.skillSnapshot),
    triggeredBy: actor,
  })
  await repository.touchSkillScheduleLastRun(schedule.id, run.createdAt)
  return run
}

/** Internal (scheduler) fire: load a schedule by id WITHOUT an org filter. */
export async function loadSkillScheduleForFire(scheduleId: string): Promise<SkillSchedule | null> {
  return repository.findSkillScheduleById(scheduleId)
}

/**
 * The scheduler's gate: disabled schedule → `disabled`; with WorkOS flag
 * enforcement the per-org `skills` flag is checked and a failure records a
 * `skipped` run (fail-closed); otherwise the run fires with scheduler
 * identity. `fireSkillSchedule` itself never throws for a skip.
 */
export async function fireScheduledSkillSchedule(
  schedule: SkillSchedule,
): Promise<{ fired: boolean; jobId?: string; reason?: 'disabled' | 'feature-disabled' | 'skipped' | 'error' }> {
  if (!schedule.enabled) {
    return { fired: false, reason: 'disabled' }
  }
  if (enforcementOn()) {
    let flagOn = false
    try {
      flagOn = await isOrgFeatureEnabled(schedule.organizationId, SKILLS_FLAG)
    } catch {
      flagOn = false
    }
    if (!flagOn) {
      await recordSkillRun(
        schedule,
        'schedule',
        'scheduler',
        'skipped',
        null,
        'Skills feature disabled for organization',
      )
      return { fired: false, reason: 'feature-disabled' }
    }
  }
  const run = await fireSkillSchedule(schedule, 'schedule', 'scheduler')
  if (run.status === 'submitted') return { fired: true, jobId: run.jobId ?? undefined }
  return { fired: false, reason: run.status === 'skipped' ? 'skipped' : 'error' }
}

// ---------------------------------------------------------------------------
// Agent resolution (internal)
// ---------------------------------------------------------------------------

/**
 * The resolved skill set for a run: platform builtins merged with the org's
 * enabled rows (org shadows platform on name), filtered by `grid-agents` when
 * an agent is named (absent = all agents). No session — the internal resolve
 * route serves the backend's /v1/chat/skills.
 */
export async function resolveSkillsForAgent(
  organizationId: string,
  agent?: string,
): Promise<{
  skills: { name: string; description: string; body: string; metadata: Record<string, string>; origin: SkillOrigin | 'platform' }[]
}> {
  const rows = await repository.listSkillsInOrg(organizationId)
  const byName = new Map<string, { name: string; description: string; body: string; metadata: Record<string, string>; origin: SkillOrigin | 'platform' }>()
  for (const platform of listPlatformSkills()) {
    // Platform metadata rides along VERBATIM. Sending `{}` here dropped the
    // reserved `grid-*` keys, and because the backend resolver merges this
    // payload OVER its own filesystem copy, the shipped
    // `grid-execution: deep-research` targeting was erased on arrival — the
    // chat agent was then offered writer/sandbox skills it cannot execute.
    if (agent && !skillTargetsAgent(platform.metadata, agent)) continue
    byName.set(platform.name, {
      name: platform.name,
      description: platform.description,
      body: platform.body,
      metadata: { ...platform.metadata },
      origin: 'platform',
    })
  }
  for (const row of rows) {
    if (!row.enabled) continue
    if (agent && !skillTargetsAgent(row.metadata, agent)) continue
    byName.set(row.name, {
      name: row.name,
      description: row.description,
      body: row.body,
      metadata: { ...row.metadata },
      origin: row.origin,
    })
  }
  return { skills: [...byName.values()] }
}

/**
 * Whether a skill applies to `agent` — the mirror of the backend resolver's
 * `_skill_applies_to_agent` (`src/aiq_agent/skills/resolver.py`).
 *
 * Two independent gates, both from reserved frontmatter metadata:
 *
 *  - `grid-agents`: a comma-separated allowlist; absent = every agent. Names
 *    that match no known agent are ignored rather than obeyed, so a typo
 *    cannot silently delete a skill from every agent at once.
 *  - `grid-execution`: `chat` skills reach the shallow/chat researcher,
 *    `deep-research` skills reach the deep researcher. A skill written for one
 *    runtime is not merely unhelpful in the other — a deep-research skill's
 *    instructions call `execute` and write `/shared/`, neither of which exists
 *    in a chat turn.
 *
 * Kept deliberately close to the Python in shape as well as behaviour: the two
 * are a contract pair, and `service.spec.ts` pins them against the same cases.
 */
function skillTargetsAgent(metadata: Record<string, string>, agent: string): boolean {
  const raw = metadata[METADATA_AGENTS]
  if (raw) {
    const listed = raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    const known = listed.filter((name) => (KNOWN_SKILL_AGENTS as readonly string[]).includes(name))
    if (known.length > 0 && !known.includes(agent)) return false
  }

  const execution = metadata[METADATA_EXECUTION]
  if (execution === 'chat') return agent === 'shallow_researcher'
  if (execution === 'deep-research') return agent === 'deep_researcher'
  return true
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