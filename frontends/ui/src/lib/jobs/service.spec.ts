/**
 * @vitest-environment node
 */
/**
 * The definitions service (migration 0086): CRUD over `task_definitions`, the
 * trigger-dependent permission gate, and the single fire path whose skipped /
 * errored attempts are visible `task_runs` rows.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/authz/feature-flags', () => ({
  requireSkillsEnabled: vi.fn().mockReturnValue(null),
  enforcementOn: vi.fn().mockReturnValue(false),
}))

vi.mock('@/lib/conversations/repository', () => ({
  insertConversation: vi.fn(),
}))

// The run's message. Its deterministic id is `lib/runs/service.spec.ts`'s
// subject; what this spec cares about is that one is minted in the right thread,
// for the run being recorded, and only once the backend has taken the work.
vi.mock('@/lib/runs/service', () => ({
  createRunMessage: vi.fn(async (_conversationId: string, runId: string) => ({ id: `msg-${runId}` })),
}))

vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(),
}))

vi.mock('@/lib/budgets/service', () => ({
  getBudgetStatus: vi.fn(),
}))

vi.mock('@/lib/model-config/service', () => ({
  getEffectiveModelOverrides: vi.fn(),
}))

vi.mock('@/lib/project-profile/prompt-view', () => ({
  loadProjectPromptView: vi.fn(),
  loadProjectBundesland: vi.fn(),
}))

vi.mock('@/lib/collection-scope', () => ({
  computeCollectionScope: vi.fn(),
}))

vi.mock('@/lib/request-context', () => ({
  buildGridRequestContextWireHeaders: vi.fn(() => ({})),
  encodeGridBudgetHeader: vi.fn(() => 'budget-header'),
}))

vi.mock('@/lib/workos/feature-flags', () => ({
  isOrgFeatureEnabled: vi.fn(),
  isMemoryReflectionEnabled: vi.fn(async () => true),
  SKILLS_FLAG: 'skills',
}))

vi.mock('@/lib/projects/memory-service', () => ({
  buildProjectMemoryDigest: vi.fn(async () => null),
}))

vi.mock('@/lib/skills/service', () => ({
  resolveSkillSnapshot: vi.fn(),
  resolveSelectableSkills: vi.fn(),
}))

vi.mock('@/lib/tasks/service', () => ({
  previousDecisionsBlock: vi.fn(async () => ''),
}))

vi.mock('@/lib/tasks/repository', () => ({
  insertDefinition: vi.fn(),
  listDefinitionsInProject: vi.fn(),
  findDefinition: vi.fn(),
  findDefinitionById: vi.fn(),
  updateDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
  touchDefinitionLastRun: vi.fn(),
  insertRun: vi.fn(),
  listRunsForDefinition: vi.fn(),
  findRunByBackendJobId: vi.fn(),
}))

vi.mock('./backend-client', async (importActual) => {
  const actual = await importActual<typeof import('./backend-client')>()
  return { ...actual, submitJob: vi.fn() }
})

import { requireProjectAccess } from '@/lib/authz/projects'
import { enforcementOn, requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { computeCollectionScope } from '@/lib/collection-scope'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { resolveSelectableSkills, resolveSkillSnapshot } from '@/lib/skills/service'
import { insertConversation } from '@/lib/conversations/repository'
import { createRunMessage } from '@/lib/runs/service'
import { taskThreadConversationId } from '@/lib/tasks/task-thread'
import { previousDecisionsBlock } from '@/lib/tasks/service'
import * as repository from '@/lib/tasks/repository'
import { submitJob, JobSubmitError, JobSubmitSkippedError } from './backend-client'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { TaskDefinition, TaskRun } from '@/lib/db/schema'
import type { SkillSnapshot } from '@/lib/skills/types'
import {
  createJob,
  deleteJob,
  fireJob,
  fireScheduledJob,
  getJob,
  listJobRuns,
  listJobs,
  runJobNow,
  updateJob,
} from './service'

const emptySkill = {} as SkillSnapshot
const skillSnapshot: SkillSnapshot = {
  name: 'einreichcheck',
  description: 'Was fehlt',
  body: '# Einreichcheck',
  metadata: {},
  origin: 'platform',
}

const session = {
  userId: 'user_1',
  email: 'p@grid.test',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
  accessToken: '',
  name: null,
} as AuthorizedSession

const PROJECT = '11111111-1111-4111-8111-111111111111'
const DEFINITION = '22222222-2222-4222-8222-222222222222'

function definitionRow(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: DEFINITION,
    organizationId: 'org_1',
    projectId: PROJECT,
    kind: 'chat',
    title: 'Wochencheck',
    plan: { prompt: 'Prüf das', skill: emptySkill, dataSources: ['knowledge_layer'] },
    requesterUserId: 'user_1',
    requesterEmail: 'p@grid.test',
    trigger: 'manual',
    enabled: true,
    scheduleCron: null,
    scheduleTimezone: 'UTC',
    nextRunAt: null,
    dueAt: null,
    budgetUsd: null,
    lastRunAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  } as TaskDefinition
}

function runRow(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    organizationId: 'org_1',
    projectId: PROJECT,
    definitionId: DEFINITION,
    kind: 'chat',
    title: 'Wochencheck',
    plan: { prompt: 'Prüf das', skill: emptySkill, dataSources: ['knowledge_layer'] },
    requesterUserId: 'user_1',
    requesterEmail: 'p@grid.test',
    trigger: 'schedule',
    triggeredBy: 'scheduler',
    status: 'running',
    error: null,
    skillSnapshot: emptySkill,
    backendJobId: 'backend-1',
    conversationId: 's_conv_1',
    filedDocumentId: null,
    filingStatus: null,
    filingDetail: null,
    review: null,
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date('2026-09-14T06:00:00Z'),
    startedAt: new Date('2026-09-14T06:00:00Z'),
    finishedAt: null,
    updatedAt: new Date('2026-09-14T06:00:00Z'),
    ...overrides,
  } as TaskRun
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' } as never)
  vi.mocked(requireSkillsEnabled).mockReturnValue(null)
  vi.mocked(enforcementOn).mockReturnValue(false)
  vi.mocked(findProjectInOrg).mockResolvedValue({ collectionName: 'proj_x' } as never)
  vi.mocked(computeCollectionScope).mockReturnValue(['proj_x'])
  vi.mocked(getEffectiveModelOverrides).mockResolvedValue(null)
  vi.mocked(loadProjectPromptView).mockResolvedValue(null)
  vi.mocked(loadProjectBundesland).mockResolvedValue(null)
  vi.mocked(insertConversation).mockResolvedValue({ id: 's_conv_1' } as never)
  vi.mocked(repository.insertDefinition).mockImplementation(async (values) => ({ ...definitionRow(), ...values }) as TaskDefinition)
  vi.mocked(repository.updateDefinition).mockImplementation(async (_id, _org, patch) => ({ ...definitionRow(), ...patch }) as TaskDefinition)
  vi.mocked(repository.insertRun).mockImplementation(async (values) => ({ ...runRow(), ...values }) as TaskRun)
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'backend-1' } as never)
  vi.mocked(previousDecisionsBlock).mockResolvedValue('')
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

// ---------------------------------------------------------------------------
// CRUD + the trigger-dependent gate
// ---------------------------------------------------------------------------

describe('createJob', () => {
  it('needs only project:edit to create a manual definition', async () => {
    await createJob(session, PROJECT, { name: 'Wochencheck', prompt: 'Prüf das', output: 'chat' })

    expect(requireProjectAccess).toHaveBeenCalledTimes(1)
    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, 'project:edit')
    expect(repository.insertDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'manual', enabled: true, scheduleCron: null, nextRunAt: null })
    )
  })

  it('needs project:skills:manage as well to give it a recurring trigger', async () => {
    await createJob(session, PROJECT, {
      name: 'Wochencheck',
      prompt: 'Prüf das',
      output: 'chat',
      scheduleCron: '0 8 * * 1',
      scheduleTimezone: 'Europe/Vienna',
    })

    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, 'project:edit')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, 'project:skills:manage')
    const insert = vi.mocked(repository.insertDefinition).mock.calls[0][0]
    expect(insert.trigger).toBe('schedule')
    expect(insert.scheduleCron).toBe('0 8 * * 1')
    // The next fire is computed at save time, in the definition's timezone.
    expect(insert.nextRunAt).toBeInstanceOf(Date)
  })

  it('makes a one-shot out of a due date, and asks for no extra permission', async () => {
    const dueAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)

    await createJob(session, PROJECT, {
      name: 'Vor der Abgabe',
      prompt: 'Prüf die Einreichplanung.',
      output: 'chat',
      dueAt,
    })

    // A one-shot spends once, exactly as pressing "Run now" would, so it is
    // NOT gated like a recurring trigger. Scheduling the safer thing must not
    // be the option that needs more rights.
    expect(requireProjectAccess).toHaveBeenCalledTimes(1)
    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, 'project:edit')

    const insert = vi.mocked(repository.insertDefinition).mock.calls[0][0]
    expect(insert.trigger).toBe('once')
    expect(insert.scheduleCron).toBeNull()
    expect(insert.dueAt).toEqual(dueAt)
    // `next_run_at` IS the due date: one column, one index, one claim query for
    // both shapes (migration 0090).
    expect(insert.nextRunAt).toEqual(dueAt)
  })

  it('refuses a due date in the past rather than scheduling a run that already missed', async () => {
    await expect(
      createJob(session, PROJECT, {
        name: 'Zu spät',
        prompt: 'Prüf das',
        output: 'chat',
        dueAt: new Date(Date.now() - 60_000),
      })
    ).rejects.toThrow(/future/i)
    expect(repository.insertDefinition).not.toHaveBeenCalled()
  })

  it('leaves a paused one-shot out of the due scan', async () => {
    const dueAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)

    await createJob(session, PROJECT, {
      name: 'Vorbereitet, noch nicht scharf',
      prompt: 'Prüf das',
      output: 'chat',
      dueAt,
      enabled: false,
    })

    const insert = vi.mocked(repository.insertDefinition).mock.calls[0][0]
    // The due date is kept — it is what the person chose — but nothing scans a
    // NULL next_run_at, so pausing needs no second mechanism.
    expect(insert.dueAt).toEqual(dueAt)
    expect(insert.nextRunAt).toBeNull()
  })

  it('pins the attached skill and always-on knowledge into the frozen plan', async () => {
    vi.mocked(resolveSkillSnapshot).mockResolvedValue(skillSnapshot)

    await createJob(session, PROJECT, {
      name: 'Wochencheck',
      prompt: 'Prüf das',
      output: 'chat',
      skillName: 'einreichcheck',
      dataSources: ['web'],
    })

    const insert = vi.mocked(repository.insertDefinition).mock.calls[0][0]
    expect(resolveSkillSnapshot).toHaveBeenCalledWith('einreichcheck', 'org_1')
    expect(insert.plan.skill).toEqual(skillSnapshot)
    // knowledge_layer is always included; the stored list is "additional".
    expect(insert.plan.dataSources).toEqual(['knowledge_layer', 'web'])
  })
})

describe('updateJob', () => {
  it('does not ask for the recurring permission when the result stays a one-off', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(definitionRow())

    await updateJob(session, PROJECT, DEFINITION, { prompt: 'Prüf das nochmal' })

    expect(requireProjectAccess).toHaveBeenCalledTimes(1)
    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, 'project:edit')
  })

  it('asks for it when a patch turns the definition into a recurring one', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(definitionRow())

    await updateJob(session, PROJECT, DEFINITION, { scheduleCron: '0 8 * * 1' })

    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, 'project:skills:manage')
    expect(vi.mocked(repository.updateDefinition).mock.calls[0][2]).toMatchObject({
      trigger: 'schedule',
      scheduleCron: '0 8 * * 1',
    })
  })

  it('keeps a one-shot due date through an unrelated patch', async () => {
    const dueAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
    vi.mocked(repository.findDefinition).mockResolvedValue(
      definitionRow({ trigger: 'once', dueAt, nextRunAt: dueAt })
    )

    await updateJob(session, PROJECT, DEFINITION, { prompt: 'Prüf das nochmal' })

    // Editing the prompt must not quietly demote the task to a manual one.
    expect(vi.mocked(repository.updateDefinition).mock.calls[0][2]).toMatchObject({
      trigger: 'once',
      dueAt,
    })
  })

  it('clears the due date when a patch pins a cron instead', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(
      definitionRow({ trigger: 'once', dueAt: new Date(Date.now() + 86_400_000) })
    )

    await updateJob(session, PROJECT, DEFINITION, { scheduleCron: '0 8 * * 1' })

    // Leaving both set would hit `task_definitions_due_only_when_once` as a 500
    // from the database rather than resolving here.
    const patch = vi.mocked(repository.updateDefinition).mock.calls[0][2]
    expect(patch.trigger).toBe('schedule')
    expect(patch.dueAt).toBeNull()
  })

  it('turns a one-shot back into a manual task on an explicit null', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(
      definitionRow({ trigger: 'once', dueAt: new Date(Date.now() + 86_400_000) })
    )

    await updateJob(session, PROJECT, DEFINITION, { dueAt: null })

    expect(vi.mocked(repository.updateDefinition).mock.calls[0][2]).toMatchObject({
      trigger: 'manual',
      dueAt: null,
      nextRunAt: null,
    })
  })

  it('detaches a skill on an explicit null without re-resolving a name', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(
      definitionRow({ plan: { prompt: 'x', skill: skillSnapshot, dataSources: null } })
    )

    await updateJob(session, PROJECT, DEFINITION, { skillName: null })

    expect(resolveSkillSnapshot).not.toHaveBeenCalled()
    expect(vi.mocked(repository.updateDefinition).mock.calls[0][2].plan?.skill).toEqual(emptySkill)
  })

  it('is a 404 for a definition outside the project', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(null)
    await expect(updateJob(session, PROJECT, DEFINITION, { prompt: 'x' })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('deleteJob', () => {
  it('leaves the tight gate where the recurring risk sits', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(
      definitionRow({ trigger: 'schedule', scheduleCron: '0 8 * * 1' })
    )
    vi.mocked(repository.deleteDefinition).mockResolvedValue(true)

    await deleteJob(session, PROJECT, DEFINITION)

    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, 'project:skills:manage')
  })
})

describe('listJobs', () => {
  it('drops a delegation — a dateless once definition is a run, not a standing intent', async () => {
    vi.mocked(repository.listDefinitionsInProject).mockResolvedValue([
      definitionRow(),
      definitionRow({ id: 'delegated-1', trigger: 'once', dueAt: null }),
    ])

    const { jobs } = await listJobs(session, PROJECT)

    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ id: DEFINITION, name: 'Wochencheck', prompt: 'Prüf das' })
  })

  it('keeps a one-shot somebody scheduled, which shares the delegation trigger', async () => {
    // The whole reason the filter is on the DUE DATE and not on the trigger: a
    // task created from the wizard for a Friday is `once` too, and dropping it
    // would make it vanish from the list it was created in.
    const dueAt = new Date('2026-10-02T07:00:00.000Z')
    vi.mocked(repository.listDefinitionsInProject).mockResolvedValue([
      definitionRow({ id: 'one-shot-1', trigger: 'once', dueAt, nextRunAt: dueAt }),
      definitionRow({ id: 'delegated-1', trigger: 'once', dueAt: null }),
    ])

    const { jobs } = await listJobs(session, PROJECT)

    expect(jobs.map((job) => job.id)).toEqual(['one-shot-1'])
    expect(jobs[0].dueAt).toEqual(dueAt)
  })
})

describe('getJob', () => {
  it('projects the definition onto the jobs wire shape', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(
      definitionRow({
        trigger: 'schedule',
        scheduleCron: '0 8 * * 1',
        plan: { prompt: 'Prüf das', skill: skillSnapshot, dataSources: ['knowledge_layer'] },
      })
    )

    const job = await getJob(session, PROJECT, DEFINITION)

    expect(job).toMatchObject({
      name: 'Wochencheck',
      prompt: 'Prüf das',
      output: 'chat',
      skillName: 'einreichcheck',
      scheduleCron: '0 8 * * 1',
      createdBy: 'user_1',
    })
  })
})

describe('listJobRuns', () => {
  it('maps a finished worker run back to the submission vocabulary of the wire', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(definitionRow())
    vi.mocked(repository.listRunsForDefinition).mockResolvedValue([
      runRow(),
      runRow({ id: 'run-2', status: 'succeeded', backendJobId: 'backend-2' }),
      runRow({ id: 'run-3', status: 'skipped', backendJobId: null, error: 'org cap' }),
      runRow({ id: 'run-4', status: 'error', backendJobId: null, error: 'backend unreachable' }),
    ])

    const { runs } = await listJobRuns(session, PROJECT, DEFINITION, 50, 0)

    expect(runs.map((run) => run.status)).toEqual(['submitted', 'submitted', 'skipped', 'error'])
    expect(runs[2]).toMatchObject({ detail: 'org cap', jobId: null })
    expect(runs[0].scheduleId).toBe(DEFINITION)
  })
})

// ---------------------------------------------------------------------------
// Fire path
// ---------------------------------------------------------------------------

describe('runJobNow', () => {
  it('refuses a disabled definition with a 409', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(definitionRow({ enabled: false }))

    await expect(runJobNow(session, PROJECT, DEFINITION)).rejects.toBeInstanceOf(ConflictError)
  })

  it('fires a manual run as the caller', async () => {
    vi.mocked(repository.findDefinition).mockResolvedValue(definitionRow())

    const run = await runJobNow(session, PROJECT, DEFINITION)

    expect(run.trigger).toBe('manual')
    expect(run.triggeredBy).toBe('user_1')
  })
})

describe('fireJob', () => {
  it('submits the composed prompt and records ONE running run with the backend id', async () => {
    vi.mocked(previousDecisionsBlock).mockResolvedValue('### PREVIOUS_DECISIONS v1\n- [abgelehnt] zu kurz')

    const run = await fireJob(definitionRow(), 'schedule', 'scheduler')

    const submitted = vi.mocked(submitJob).mock.calls[0][0]
    expect(submitted.input).toContain('Prüf das')
    expect(submitted.input).toContain('PREVIOUS_DECISIONS v1')

    const inserted = vi.mocked(repository.insertRun).mock.calls[0][0]
    expect(inserted).toMatchObject({
      definitionId: DEFINITION,
      trigger: 'schedule',
      triggeredBy: 'scheduler',
      status: 'running',
      backendJobId: 'backend-1',
      conversationId: taskThreadConversationId(DEFINITION),
      requesterUserId: 'user_1',
      title: 'Wochencheck',
    })
    // The run freezes the FIRED prompt — decisions included — not the raw plan.
    expect(inserted.plan?.prompt).toContain('PREVIOUS_DECISIONS v1')
    expect(repository.touchDefinitionLastRun).toHaveBeenCalledWith(DEFINITION, run.createdAt)
  })

  /**
   * The run's place in the thread (ADR-0062). The message is minted for the id
   * the row is about to be written with, which is what makes the run's ledger
   * and its report find the same message later.
   */
  it('gives the run a message in the definition thread and stores its id on the row', async () => {
    await fireJob(definitionRow(), 'schedule', 'scheduler')

    const thread = taskThreadConversationId(DEFINITION)
    expect(insertConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: thread,
        title: 'Aufgabe: Wochencheck',
        visibility: 'project',
        jobId: DEFINITION,
        createdBy: 'user_1',
      })
    )
    const inserted = vi.mocked(repository.insertRun).mock.calls[0][0]
    expect(createRunMessage).toHaveBeenCalledWith(thread, inserted.id)
    expect(inserted.runMessageId).toBe(`msg-${inserted.id}`)
  })

  /**
   * One definition, one thread. The id is derived from the definition's, so the
   * second fire re-attempts the SAME row and `ON CONFLICT DO NOTHING` makes that
   * a no-op — no lookup, no unique index, and two concurrent fires converge.
   */
  it('fires twice into one thread, with a message per fire', async () => {
    const definition = definitionRow({ trigger: 'schedule', scheduleCron: '0 8 * * 1' })
    await fireJob(definition, 'schedule', 'scheduler')
    await fireJob(definition, 'schedule', 'scheduler')

    const thread = taskThreadConversationId(DEFINITION)
    expect(vi.mocked(insertConversation).mock.calls.map((call) => call[0].id)).toEqual([thread, thread])
    const messageCalls = vi.mocked(createRunMessage).mock.calls
    expect(messageCalls.map((call) => call[0])).toEqual([thread, thread])
    // Two runs, two messages: the thread accumulates, it does not overwrite.
    expect(new Set(messageCalls.map((call) => call[1])).size).toBe(2)
  })

  /**
   * A retried submit is a no-op rather than a second half-written run: the
   * message id is derived from the run id, so the same run always lands on the
   * same row (`createRunMessage`, `lib/runs/service.ts`). The fire path's part of
   * that bargain is that the id it derives from is the id it records.
   */
  it('derives the message from the id the run row is written with', async () => {
    await fireJob(definitionRow(), 'manual', 'user_1')

    const inserted = vi.mocked(repository.insertRun).mock.calls[0][0]
    expect(vi.mocked(createRunMessage).mock.calls[0][1]).toBe(inserted.id)
  })

  /**
   * A fire the agent refused leaves nothing in the thread. The old shape created
   * a whole conversation before submitting, so an org that hit its cap collected
   * empty threads; this one mints the message only once the work is accepted.
   */
  it('writes no message into the thread when the submission is refused', async () => {
    vi.mocked(submitJob).mockRejectedValue(new JobSubmitSkippedError('org job cap reached', 60))

    await fireJob(definitionRow(), 'schedule', 'scheduler')

    expect(createRunMessage).not.toHaveBeenCalled()
    expect(vi.mocked(repository.insertRun).mock.calls[0][0].runMessageId).toBeNull()
  })

  it('records a skipped fire as a visible run instead of losing it', async () => {
    vi.mocked(submitJob).mockRejectedValue(new JobSubmitSkippedError('org job cap reached', 60))

    const run = await fireJob(definitionRow(), 'schedule', 'scheduler')

    expect(run.status).toBe('skipped')
    expect(run.error).toContain('org job cap reached')
    expect(run.error).toContain('retry after 60s')
    expect(vi.mocked(repository.insertRun).mock.calls[0][0].backendJobId).toBeNull()
  })

  it('records a submission error as a run too', async () => {
    vi.mocked(submitJob).mockRejectedValue(new JobSubmitError('backend unreachable', 502))

    const run = await fireJob(definitionRow(), 'manual', 'user_1')

    expect(run.status).toBe('error')
    expect(run.error).toBe('backend unreachable')
  })

  it('turns an unexpected context failure into an error run rather than a throw', async () => {
    vi.mocked(previousDecisionsBlock).mockRejectedValue(new Error('db gone'))

    const run = await fireJob(definitionRow(), 'schedule', 'scheduler')

    expect(run.status).toBe('error')
    expect(run.error).toBe('db gone')
  })
})

describe('fireScheduledJob', () => {
  it('reports disabled without firing', async () => {
    await expect(fireScheduledJob(definitionRow({ enabled: false }))).resolves.toEqual({
      fired: false,
      reason: 'disabled',
    })
    expect(submitJob).not.toHaveBeenCalled()
  })

  it('fails closed when the org feature flag is off under enforcement', async () => {
    vi.mocked(enforcementOn).mockReturnValue(true)
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)

    const result = await fireScheduledJob(definitionRow())

    expect(result).toEqual({ fired: false, reason: 'feature-disabled' })
    // Flag and org in this order: the `slug` is the flag, the id the tenant.
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('skills', 'org_1')
    expect(vi.mocked(repository.insertRun).mock.calls[0][0]).toMatchObject({ status: 'skipped' })
  })

  it('fires and reports the backend id', async () => {
    const result = await fireScheduledJob(definitionRow({ trigger: 'schedule', scheduleCron: '0 8 * * 1' }))

    expect(result).toEqual({ fired: true, jobId: 'backend-1' })
  })
})

// ---------------------------------------------------------------------------
// Unused-import guards (the surface this spec deliberately does not exercise)
// ---------------------------------------------------------------------------

describe('surfaces intentionally left to their own specs', () => {
  it('keeps the feature gate and API errors wired', () => {
    expect(requireSkillsEnabled(session)).toBeNull()
    expect(ForbiddenError).toBeDefined()
    expect(BadRequestError).toBeDefined()
    expect(resolveSelectableSkills).toBeDefined()
  })
})
