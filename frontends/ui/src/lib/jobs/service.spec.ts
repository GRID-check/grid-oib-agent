/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn(async () => 1),
}))

vi.mock('@/lib/projects/memory-service', () => ({
  buildProjectMemoryDigest: vi.fn(async () => 'PROJECT_MEMORY v1\n- Atrium ist OIB 2.3'),
}))

vi.mock('@/lib/skills/service', () => ({
  resolveSkillSnapshot: vi.fn(),
  resolveSelectableSkills: vi.fn(),
}))

vi.mock('./repository', () => ({
  insertJob: vi.fn(),
  listJobsInProject: vi.fn(),
  findJob: vi.fn(),
  findJobById: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(),
  touchJobLastRun: vi.fn(),
  insertJobRun: vi.fn(),
  listJobRuns: vi.fn(),
}))

vi.mock('./backend-client', async (importActual) => {
  const actual = await importActual<typeof import('./backend-client')>()
  return { ...actual, submitJob: vi.fn() }
})

import { requireProjectAccess } from '@/lib/authz/projects'
import { requireSkillsEnabled, enforcementOn } from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { computeCollectionScope } from '@/lib/collection-scope'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { resolveSelectableSkills, resolveSkillSnapshot } from '@/lib/skills/service'
import { insertConversation } from '@/lib/conversations/repository'
import * as repository from './repository'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { emitInboxItems } from '@/lib/inbox/service'
import { buildGridRequestContextWireHeaders } from '@/lib/request-context'
import { submitJob, JobSubmitSkippedError, JobSubmitError } from './backend-client'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { Job, JobRun } from '@/lib/db/schema'
import type { SkillSnapshot } from '@/lib/skills/types'
import {
  buildFirePrompt,
  createJob,
  fireJob,
  recordJobOutcome,
  fireScheduledJob,
  getJob,
  listAttachableSkills,
  listJobs,
  runJobNow,
  updateJob,
} from './service'

type Session = Parameters<typeof listJobs>[0]

const session: Session = {
  userId: 'user_1',
  email: 'user@example.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const SNAPSHOT: SkillSnapshot = {
  name: 'my-skill',
  description: 'Does the thing.',
  body: 'Body.',
  metadata: {},
  origin: 'org',
}

function makeJob(overrides: Partial<Job> = {}): Job {
  const base: Job = {
    id: 'job-1',
    projectId: 'proj-1',
    organizationId: 'org_1',
    name: 'Weekly run',
    prompt: 'Fasse die Woche zusammen.',
    skillName: 'my-skill',
    skillSnapshot: SNAPSHOT,
    output: 'chat',
    dataSources: null,
    enabled: true,
    scheduleCron: '0 9 * * 1',
    scheduleTimezone: 'UTC',
    nextRunAt: new Date('2025-02-01T09:00:00Z'),
    lastRunAt: null,
    createdBy: 'owner_9',
    createdByEmail: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
  }
  return { ...base, ...overrides }
}

function makeRun(overrides: Partial<JobRun> = {}): JobRun {
  const base: JobRun = {
    id: 'run-1',
    scheduleId: 'job-1',
    projectId: 'proj-1',
    organizationId: 'org_1',
    jobId: null,
    trigger: 'manual',
    status: 'submitted',
    detail: null,
    conversationId: null,
    skillSnapshot: SNAPSHOT,
    triggeredBy: 'user_1',
    createdAt: new Date('2025-01-01T00:00:00Z'),
  }
  return { ...base, ...overrides }
}

beforeEach(() => {
  vi.mocked(requireSkillsEnabled).mockReturnValue(null)
  vi.mocked(enforcementOn).mockReturnValue(false)
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
  vi.mocked(findProjectInOrg).mockResolvedValue({
    id: 'proj-1',
    organizationId: 'org_1',
    name: 'Test project',
  } as never)
  vi.mocked(computeCollectionScope).mockReturnValue(['oib_knowledge', 'proj_1'])
  vi.mocked(getEffectiveModelOverrides).mockResolvedValue(null)
  vi.mocked(loadProjectPromptView).mockResolvedValue(null)
  vi.mocked(loadProjectBundesland).mockResolvedValue(null)
  vi.mocked(resolveSkillSnapshot).mockResolvedValue(SNAPSHOT)
  vi.mocked(resolveSelectableSkills).mockResolvedValue({ skills: [] })
  vi.mocked(repository.findJob).mockResolvedValue(null)
  vi.mocked(repository.insertJob).mockImplementation(async (values) => makeJob(values as Partial<Job>))
  vi.mocked(repository.insertJobRun).mockImplementation(async (values) =>
    makeRun({
      status: values.status,
      jobId: values.jobId,
      skillSnapshot: values.skillSnapshot,
      detail: values.detail,
      conversationId: values.conversationId ?? null,
      triggeredBy: values.triggeredBy,
    })
  )
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'backend-job-1' })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('feature gate', () => {
  it('rejects every session call when the feature is off', async () => {
    vi.mocked(requireSkillsEnabled).mockReturnValue({ status: 403 } as Response)
    await expect(listJobs(session, 'proj-1')).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      createJob(session, 'proj-1', { name: 'W', prompt: 'p', output: 'chat' })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('createJob', () => {
  it('stores a plain prompt with NO skill — name and snapshot null together', async () => {
    const job = await createJob(session, 'proj-1', {
      name: 'Monday question',
      prompt: 'Was ist neu in der OIB 6?',
      output: 'chat',
    })
    expect(resolveSkillSnapshot).not.toHaveBeenCalled()
    expect(job.skillName).toBeNull()
    expect(job.skillSnapshot).toBeNull()
    expect(repository.insertJob).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Was ist neu in der OIB 6?',
        skillName: null,
        skillSnapshot: null,
        output: 'chat',
      })
    )
  })

  it('snapshots the attached skill when one is named', async () => {
    const job = await createJob(session, 'proj-1', {
      name: 'Weekly',
      prompt: 'Fasse zusammen.',
      output: 'deep-research',
      skillName: 'my-skill',
    })
    expect(resolveSkillSnapshot).toHaveBeenCalledWith('my-skill', 'org_1')
    expect(job.skillName).toBe('my-skill')
    expect(job.skillSnapshot?.body).toBe('Body.')
  })

  it('404s on an unknown skill name', async () => {
    vi.mocked(resolveSkillSnapshot).mockRejectedValue(new NotFoundError('Unknown skill "nope".'))
    await expect(
      createJob(session, 'proj-1', { name: 'W', prompt: 'p', output: 'chat', skillName: 'nope' })
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('computes next_run_at from a cron and never vetoes on the skill', async () => {
    // `grid-schedulable` is gone: whether something runs on a timer is a
    // property of the job, not of a skill that knows nothing about time.
    vi.mocked(resolveSkillSnapshot).mockResolvedValue({
      ...SNAPSHOT,
      metadata: { 'grid-schedulable': 'false' },
    })
    const job = await createJob(session, 'proj-1', {
      name: 'Weekly',
      prompt: 'p',
      output: 'chat',
      skillName: 'my-skill',
      scheduleCron: '0 9 * * 1',
    })
    expect(job.nextRunAt).not.toBeNull()
  })

  it('rejects an invalid cron at save time', async () => {
    await expect(
      createJob(session, 'proj-1', {
        name: 'W',
        prompt: 'p',
        output: 'chat',
        scheduleCron: '* * * * *',
      })
    ).rejects.toBeInstanceOf(BadRequestError)
  })
})

describe('updateJob', () => {
  it('leaves the attachment alone when skillName is absent', async () => {
    vi.mocked(repository.findJob).mockResolvedValue(makeJob())
    vi.mocked(repository.updateJob).mockImplementation(async (id, orgId, values) =>
      makeJob(values as Partial<Job>)
    )
    const updated = await updateJob(session, 'proj-1', 'job-1', { prompt: 'Neu.' })
    expect(resolveSkillSnapshot).not.toHaveBeenCalled()
    expect(updated.skillName).toBe('my-skill')
    expect(updated.prompt).toBe('Neu.')
  })

  it('detaches the skill as a PAIR when skillName is null', async () => {
    vi.mocked(repository.findJob).mockResolvedValue(makeJob())
    vi.mocked(repository.updateJob).mockImplementation(async (id, orgId, values) =>
      makeJob(values as Partial<Job>)
    )
    const updated = await updateJob(session, 'proj-1', 'job-1', { skillName: null })
    expect(updated.skillName).toBeNull()
    expect(updated.skillSnapshot).toBeNull()
    expect(repository.updateJob).toHaveBeenCalledWith(
      'job-1',
      'org_1',
      expect.objectContaining({ skillName: null, skillSnapshot: null })
    )
  })

  it('re-snapshots when the attached skill changes', async () => {
    vi.mocked(repository.findJob).mockResolvedValue(makeJob())
    vi.mocked(resolveSkillSnapshot).mockResolvedValue({
      ...SNAPSHOT,
      name: 'other-skill',
      description: 'Other.',
    })
    vi.mocked(repository.updateJob).mockImplementation(async (id, orgId, values) =>
      makeJob(values as Partial<Job>)
    )
    const updated = await updateJob(session, 'proj-1', 'job-1', { skillName: 'other-skill' })
    expect(updated.skillSnapshot?.name).toBe('other-skill')
    expect(updated.skillSnapshot?.description).toBe('Other.')
  })
})

describe('buildFirePrompt', () => {
  it('is the prompt and nothing else when no skill is attached', () => {
    const prompt = buildFirePrompt({ prompt: '  Was ist neu?  ', skill: null })
    expect(prompt).toBe('Was ist neu?')
    expect(prompt).not.toContain('Skill:')
    expect(prompt).not.toContain('Beschreibung:')
    expect(prompt).not.toContain('---')
  })

  it('appends the skill body verbatim when one is attached', () => {
    const prompt = buildFirePrompt({ prompt: 'Fasse zusammen.', skill: SNAPSHOT })
    expect(prompt).toBe(
      [
        'Fasse zusammen.',
        '',
        '---',
        '',
        'Verwende dabei den folgenden Skill verbindlich und vollständig.',
        '',
        'Skill: my-skill',
        'Beschreibung: Does the thing.',
        '',
        'Body.',
        '---',
      ].join('\n')
    )
  })
})

describe('fireJob', () => {
  it('submits the composed prompt with the skill name and the output kind', async () => {
    await fireJob(makeJob({ output: 'deep-research' }), 'manual', 'user_1')
    const payload = vi.mocked(submitJob).mock.calls[0][0]
    expect(payload.skills).toEqual(['my-skill'])
    expect(payload.output).toBe('deep-research')
    expect(payload.input).toContain('Fasse die Woche zusammen.')
    expect(payload.input).toContain('Body.')
    expect(repository.insertJobRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'submitted', trigger: 'manual', jobId: 'backend-job-1' })
    )
    expect(repository.touchJobLastRun).toHaveBeenCalled()
  })

  it('sends the project memory digest and the reflection flag, ranked against the fire prompt', async () => {
    await fireJob(makeJob({ output: 'deep-research' }), 'manual', 'user_1')
    const payload = vi.mocked(submitJob).mock.calls[0][0]
    expect(payload.project_memory).toBe('PROJECT_MEMORY v1\n- Atrium ist OIB 2.3')
    expect(payload.memory_reflection_enabled).toBe(true)
    // Recall is ranked against what the job will actually ask, not left to
    // pinned-then-recent.
    const [, , options] = vi.mocked(buildProjectMemoryDigest).mock.calls[0]
    expect(options?.query).toBe(payload.input)
    // The signed envelope carries the same digest, so the worker's headers and
    // its payload can never disagree.
    const envelope = vi.mocked(buildGridRequestContextWireHeaders).mock.calls[0][0]
    expect(envelope.projectMemory).toBe('PROJECT_MEMORY v1\n- Atrium ist OIB 2.3')
    expect(envelope.memoryReflectionEnabled).toBe(true)
  })

  it('still fires when the memory digest cannot be built', async () => {
    vi.mocked(buildProjectMemoryDigest).mockRejectedValueOnce(new Error('embedder down'))
    await fireJob(makeJob({ output: 'deep-research' }), 'manual', 'user_1')
    const payload = vi.mocked(submitJob).mock.calls[0][0]
    expect(payload.project_memory).toBeNull()
    expect(repository.insertJobRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'submitted' }))
  })

  it('sends skills: [] and a bare prompt for a job with no skill', async () => {
    await fireJob(
      makeJob({ skillName: null, skillSnapshot: null, output: 'deep-research' }),
      'manual',
      'user_1',
    )
    const payload = vi.mocked(submitJob).mock.calls[0][0]
    expect(payload.skills).toEqual([])
    expect(payload.input).toBe('Fasse die Woche zusammen.')
    // job_runs.skill_snapshot is NOT NULL — a skill-less run records `{}`.
    expect(vi.mocked(repository.insertJobRun).mock.calls[0][0].skillSnapshot).toEqual({})
  })

  it('creates a PROJECT-visible conversation owned by the job owner, stamped with the job', async () => {
    // Every field here was forced by a constraint, so each is worth pinning:
    //  - createdBy is the job's OWNER, a real user id. Four mechanisms read
    //    created_by as a person (the sharing roster, the last-owner invariant,
    //    legacy author attribution, audit), so a synthetic 'scheduler' would
    //    produce a thread nobody can own, notify or audit.
    //  - visibility is 'project', not the 'private' column default. A job is a
    //    team artefact scheduled on a project, and its runs are already
    //    readable by anyone with project:view.
    //  - jobId is the provenance the UI renders instead of a person's face,
    //    and what keeps these threads out of a personal chat history.
    vi.mocked(insertConversation).mockResolvedValue({ id: 's_generated' } as never)

    const run = await fireJob(makeJob({ output: 'chat' }), 'schedule', 'scheduler')

    expect(insertConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        createdBy: 'owner_9',
        projectId: 'proj-1',
        title: 'Weekly run',
        visibility: 'project',
        jobId: 'job-1',
      })
    )
    // The `s_` prefix is not cosmetic: the id doubles as this session's Qdrant
    // collection name, so a job conversation must be minted exactly the way an
    // interactive one is.
    expect(vi.mocked(insertConversation).mock.calls[0][0].id).toMatch(/^s_[0-9a-f_]{36}$/)

    expect(vi.mocked(submitJob).mock.calls[0][0].conversation_id).toBe('s_generated')
    expect(run.conversationId).toBe('s_generated')
    expect(vi.mocked(repository.insertJobRun).mock.calls[0][0].conversationId).toBe('s_generated')
  })

  it('creates no conversation for a deep-research job — that produces a report', async () => {
    await fireJob(makeJob({ output: 'deep-research' }), 'schedule', 'scheduler')
    expect(insertConversation).not.toHaveBeenCalled()
    expect(vi.mocked(submitJob).mock.calls[0][0].conversation_id).toBeUndefined()
  })

  it('still fires when the conversation cannot be created', async () => {
    // The reverse trade — refusing to run because a row could not be written —
    // is the one outcome nobody wants at 03:00.
    vi.mocked(insertConversation).mockRejectedValue(new Error('db down'))
    const run = await fireJob(makeJob({ output: 'chat' }), 'schedule', 'scheduler')
    expect(run.status).toBe('submitted')
    expect(run.conversationId).toBeNull()
    expect(vi.mocked(submitJob).mock.calls[0][0].conversation_id).toBeUndefined()
  })

  it('records a skipped run on a 429 admission cap and never throws', async () => {
    vi.mocked(submitJob).mockRejectedValue(new JobSubmitSkippedError('cap', 13))
    const run = await fireJob(makeJob(), 'schedule', 'scheduler')
    expect(run.status).toBe('skipped')
    expect(run.detail).toContain('cap')
    expect(repository.insertJobRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped', triggeredBy: 'scheduler' })
    )
  })

  it('records an error run on a submission failure and never throws', async () => {
    vi.mocked(submitJob).mockRejectedValue(new JobSubmitError('boom', 500))
    const run = await fireJob(makeJob(), 'manual', 'user_1')
    expect(run.status).toBe('error')
    expect(run.detail).toContain('boom')
  })
})

describe('runJobNow', () => {
  it('409s when the job is disabled', async () => {
    vi.mocked(repository.findJob).mockResolvedValue(makeJob({ enabled: false }))
    await expect(runJobNow(session, 'proj-1', 'job-1')).rejects.toBeInstanceOf(ConflictError)
  })

  it('fires through the single path and returns the run', async () => {
    vi.mocked(repository.findJob).mockResolvedValue(makeJob())
    const run = await runJobNow(session, 'proj-1', 'job-1')
    expect(run.status).toBe('submitted')
    expect(submitJob).toHaveBeenCalledTimes(1)
  })
})

describe('fireScheduledJob', () => {
  it('returns disabled without firing when the job is off', async () => {
    const result = await fireScheduledJob(makeJob({ enabled: false }))
    expect(result).toEqual({ fired: false, reason: 'disabled' })
    expect(submitJob).not.toHaveBeenCalled()
  })

  it('records a skipped run when the org feature gate is off (fail-closed)', async () => {
    vi.mocked(enforcementOn).mockReturnValue(true)
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)
    const result = await fireScheduledJob(makeJob())
    expect(result).toEqual({ fired: false, reason: 'feature-disabled' })
    expect(repository.insertJobRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'skipped',
        detail: 'Skills feature disabled for organization',
      })
    )
  })

  it('fires with scheduler identity when the gate is on', async () => {
    vi.mocked(enforcementOn).mockReturnValue(true)
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
    const result = await fireScheduledJob(makeJob())
    expect(result.fired).toBe(true)
    expect(submitJob).toHaveBeenCalledTimes(1)
  })
})

describe('listAttachableSkills', () => {
  it('resolves chat against the shallow researcher and deep-research against the deep one', async () => {
    await listAttachableSkills(session, 'chat')
    expect(resolveSelectableSkills).toHaveBeenCalledWith('org_1', 'shallow_researcher')
    await listAttachableSkills(session, 'deep-research')
    expect(resolveSelectableSkills).toHaveBeenCalledWith('org_1', 'deep_researcher')
  })

  it('returns the resolved skills sorted by name', async () => {
    vi.mocked(resolveSelectableSkills).mockResolvedValue({
      skills: [
        { ...SNAPSHOT, name: 'zeta' },
        { ...SNAPSHOT, name: 'alpha' },
      ],
    })
    const { skills } = await listAttachableSkills(session, 'chat')
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'zeta'])
  })
})

describe('getJob / listJobs', () => {
  it('404s on jobs outside the org', async () => {
    await expect(getJob(session, 'proj-1', 'nope')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('returns the org-scoped jobs', async () => {
    vi.mocked(repository.listJobsInProject).mockResolvedValue([makeJob()])
    const { jobs } = await listJobs(session, 'proj-1')
    expect(jobs).toHaveLength(1)
    expect(repository.listJobsInProject).toHaveBeenCalledWith('proj-1', 'org_1')
  })
})

describe('recordJobOutcome', () => {
  const run = {
    id: 'run-1',
    scheduleId: 'job-1',
    projectId: 'proj-1',
    organizationId: 'org_1',
    jobId: 'backend-job-1',
    trigger: 'schedule',
    status: 'submitted',
    detail: null,
    conversationId: 'conv-1',
    skillSnapshot: {},
    triggeredBy: 'scheduler',
    createdAt: new Date('2026-09-01T03:00:00Z'),
  } as unknown as JobRun

  it('tells the creator of the job, one row per run, with nobody as the actor', async () => {
    vi.mocked(repository.findJobById).mockResolvedValueOnce(makeJob({ id: 'job-1', name: 'Wochenbericht' }))
    const result = await recordJobOutcome(run, { status: 'success' })
    expect(result).toEqual({ notified: true })
    const [emissions] = vi.mocked(emitInboxItems).mock.calls[0]
    expect(emissions).toHaveLength(1)
    expect(emissions[0]).toMatchObject({
      organizationId: 'org_1',
      recipientUserId: 'owner_9',
      type: 'job.completed',
      resourceType: 'project',
      resourceId: 'proj-1',
      anchorId: 'backend-job-1',
      // Piloti did the work; and the emitter drops a row whose actor is its
      // recipient, which a manual "Run now" would otherwise be.
      actorUserId: null,
      groupKey: 'job.completed:project:proj-1:backend-job-1',
    })
    expect(emissions[0].payload).toMatchObject({ subject: 'Wochenbericht', status: 'success', conversationId: 'conv-1' })
  })

  it('reports a failure as job.failed with the worker\'s error', async () => {
    vi.mocked(repository.findJobById).mockResolvedValueOnce(makeJob({ id: 'job-1' }))
    await recordJobOutcome(run, { status: 'failure', error: 'Budget exhausted' })
    const [emissions] = vi.mocked(emitInboxItems).mock.calls[0]
    expect(emissions[0].type).toBe('job.failed')
    expect(emissions[0].payload).toMatchObject({ status: 'failure', error: 'Budget exhausted' })
  })

  it('notifies nobody when the run belongs to a job of another tenant', async () => {
    vi.mocked(repository.findJobById).mockResolvedValueOnce(makeJob({ id: 'job-1', organizationId: 'org-2' }))
    expect(await recordJobOutcome(run, { status: 'success' })).toEqual({ notified: false })
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})
