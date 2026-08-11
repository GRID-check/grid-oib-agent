/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/authz/organizations', () => ({
  canManageSkills: vi.fn().mockReturnValue(true),
}))

vi.mock('@/lib/authz/feature-flags', () => ({
  requireSkillsEnabled: vi.fn().mockReturnValue(null),
  enforcementOn: vi.fn().mockReturnValue(false),
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
  SKILLS_FLAG: 'skills',
}))

vi.mock('./repository', () => ({
  insertSkill: vi.fn(),
  listSkillsInOrg: vi.fn(),
  findSkill: vi.fn(),
  findSkillByName: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  insertSkillSchedule: vi.fn(),
  listSkillSchedulesInProject: vi.fn(),
  findSkillSchedule: vi.fn(),
  findSkillScheduleById: vi.fn(),
  updateSkillSchedule: vi.fn(),
  deleteSkillSchedule: vi.fn(),
  touchSkillScheduleLastRun: vi.fn(),
  insertSkillRun: vi.fn(),
  listSkillRuns: vi.fn(),
}))

vi.mock('./backend-client', async (importActual) => {
  const actual = await importActual<typeof import('./backend-client')>()
  return { ...actual, submitSkillJob: vi.fn() }
})

vi.mock('./platform-skills', () => ({
  listPlatformSkills: vi.fn(),
  findPlatformSkill: vi.fn(),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { canManageSkills } from '@/lib/authz/organizations'
import { requireSkillsEnabled, enforcementOn } from '@/lib/authz/feature-flags'
import { findProjectInOrg } from '@/lib/projects/repository'
import { computeCollectionScope } from '@/lib/collection-scope'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import * as repository from './repository'
import { submitSkillJob, SkillSubmitSkippedError, SkillSubmitError } from './backend-client'
import { findPlatformSkill, listPlatformSkills } from './platform-skills'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { Skill, SkillRun, SkillSchedule } from '@/lib/db/schema'
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  createSkillSchedule,
  updateSkillSchedule,
  runSkillScheduleNow,
  fireSkillSchedule,
  fireScheduledSkillSchedule,
  resolveSkillsForAgent,
  listSkillSchedules,
  getSkillSchedule,
} from './service'

type Session = Parameters<typeof listSkills>[0]

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

const PLATFORM_SKILL = {
  name: 'data-table-analysis',
  description: 'Analyze tables.',
  body: '# Data Table Analysis Skill\n\nCompute deterministically.',
  metadata: {},
  origin: 'platform' as const,
  collection: 'research' as const,
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  const base: Skill = {
    id: 'skill-1',
    organizationId: 'org_1',
    name: 'my-skill',
    description: 'Does the thing.',
    body: 'Body.',
    metadata: {},
    origin: 'org',
    clonedFrom: null,
    enabled: true,
    createdBy: 'user_1',
    createdByEmail: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
  }
  return { ...base, ...overrides }
}

function makeSchedule(overrides: Partial<SkillSchedule> = {}): SkillSchedule {
  const base: SkillSchedule = {
    id: 'schedule-1',
    projectId: 'proj-1',
    organizationId: 'org_1',
    name: 'Weekly run',
    skillName: 'my-skill',
    skillSnapshot: {
      name: 'my-skill',
      description: 'Does the thing.',
      body: 'Body.',
      metadata: {},
      origin: 'org',
    },
    execution: 'chat',
    dataSources: null,
    enabled: true,
    scheduleCron: '0 9 * * 1',
    scheduleTimezone: 'UTC',
    nextRunAt: new Date('2025-02-01T09:00:00Z'),
    lastRunAt: null,
    createdBy: 'user_1',
    createdByEmail: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
  }
  return { ...base, ...overrides }
}

function makeRun(overrides: Partial<SkillRun> = {}): SkillRun {
  const base: SkillRun = {
    id: 'run-1',
    scheduleId: 'schedule-1',
    projectId: 'proj-1',
    organizationId: 'org_1',
    jobId: null,
    trigger: 'manual',
    status: 'submitted',
    detail: null,
    skillSnapshot: makeSchedule().skillSnapshot,
    triggeredBy: 'user_1',
    createdAt: new Date('2025-01-01T00:00:00Z'),
  }
  return { ...base, ...overrides }
}

beforeEach(() => {
  vi.mocked(requireSkillsEnabled).mockReturnValue(null)
  vi.mocked(enforcementOn).mockReturnValue(false)
  vi.mocked(canManageSkills).mockReturnValue(true)
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
  vi.mocked(listPlatformSkills).mockReturnValue([PLATFORM_SKILL])
  vi.mocked(findPlatformSkill).mockImplementation((name) =>
    name === PLATFORM_SKILL.name ? PLATFORM_SKILL : null
  )
  vi.mocked(repository.listSkillsInOrg).mockResolvedValue([])
  vi.mocked(repository.findSkill).mockResolvedValue(null)
  vi.mocked(repository.findSkillByName).mockResolvedValue(null)
  vi.mocked(repository.findSkillSchedule).mockResolvedValue(null)
  vi.mocked(repository.insertSkillRun).mockImplementation(async (values) =>
    makeRun({
      status: values.status,
      jobId: values.jobId,
      skillSnapshot: values.skillSnapshot,
      detail: values.detail,
    })
  )
  vi.mocked(submitSkillJob).mockResolvedValue({ jobId: 'job-1' })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('feature gate', () => {
  it('rejects every session call when the skills feature is off', async () => {
    vi.mocked(requireSkillsEnabled).mockReturnValue({ status: 403 } as Response)
    await expect(listSkills(session)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      createSkill(session, { name: 'a', description: 'b', body: 'c' })
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(listSkillSchedules(session, 'proj-1')).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('listSkills', () => {
  it('merges platform skills with org rows, org rows shadowing same names', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'data-table-analysis', description: 'org shadow' }),
      makeSkill({ id: 'skill-2', name: 'org-only' }),
    ])
    const { skills } = await listSkills(session)
    expect(skills).toHaveLength(2)
    expect(skills.find((s) => s.name === 'data-table-analysis')?.description).toBe('org shadow')
    expect(skills.find((s) => s.name === 'data-table-analysis')?.origin).toBe('org')
    expect(skills.find((s) => s.name === 'org-only')?.id).toBe('skill-2')
  })
})

describe('createSkill', () => {
  it('requires org:skills:manage', async () => {
    vi.mocked(canManageSkills).mockReturnValue(false)
    await expect(
      createSkill(session, { name: 'a', description: 'b', body: 'c' })
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('rejects an invalid grid-execution value at write time', async () => {
    await expect(
      createSkill(session, {
        name: 'a',
        description: 'b',
        body: 'c',
        metadata: { 'grid-execution': 'deep_research' },
      })
    ).rejects.toBeInstanceOf(BadRequestError)
  })

  it('conflicts on a duplicate name in the same org', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(makeSkill())
    await expect(
      createSkill(session, { name: 'my-skill', description: 'b', body: 'c' })
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('records a clone with origin platform-clone when clonedFrom is set', async () => {
    vi.mocked(repository.insertSkill).mockImplementation(async (values) => makeSkill(values))
    await createSkill(session, {
      name: 'clone-1',
      description: 'b',
      body: 'c',
      clonedFrom: 'data-table-analysis',
    })
    expect(repository.insertSkill).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'platform-clone', clonedFrom: 'data-table-analysis' })
    )
  })
})

describe('updateSkill / deleteSkill', () => {
  it('updates only the given fields and re-checks conflict on rename', async () => {
    vi.mocked(repository.findSkill).mockResolvedValue(makeSkill())
    vi.mocked(repository.updateSkill).mockImplementation(async (id, orgId, values) =>
      makeSkill(values)
    )
    await updateSkill(session, 'skill-1', { description: 'new' })
    expect(repository.updateSkill).toHaveBeenCalledWith(
      'skill-1',
      'org_1',
      expect.objectContaining({ description: 'new' })
    )

    vi.mocked(repository.findSkillByName).mockResolvedValue(makeSkill({ id: 'other' }))
    await expect(updateSkill(session, 'skill-1', { name: 'other' })).rejects.toBeInstanceOf(
      ConflictError
    )
  })

  it('404s on unknown skill ids', async () => {
    await expect(updateSkill(session, 'nope', {})).rejects.toBeInstanceOf(NotFoundError)
    await expect(deleteSkill(session, 'nope')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('createSkillSchedule', () => {
  it('resolves org skills first, platform skills second', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(makeSkill())
    vi.mocked(repository.insertSkillSchedule).mockImplementation(async (values) =>
      makeSchedule(values)
    )
    const schedule = await createSkillSchedule(session, 'proj-1', {
      name: 'Weekly',
      skillName: 'my-skill',
    })
    expect(schedule.skillName).toBe('my-skill')
    expect(schedule.execution).toBe('chat')

    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    const platformSchedule = await createSkillSchedule(session, 'proj-1', {
      name: 'Data',
      skillName: 'data-table-analysis',
    })
    expect(platformSchedule.skillSnapshot.origin).toBe('platform')
  })

  it('404s on an unknown skill name', async () => {
    await expect(
      createSkillSchedule(session, 'proj-1', { name: 'W', skillName: 'nope' })
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('vetoes cron on a non-schedulable skill', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(
      makeSkill({ metadata: { 'grid-schedulable': 'false' } })
    )
    await expect(
      createSkillSchedule(session, 'proj-1', {
        name: 'W',
        skillName: 'my-skill',
        scheduleCron: '0 9 * * 1',
      })
    ).rejects.toBeInstanceOf(BadRequestError)
  })

  it('denormalizes execution and computes next_run_at from a cron', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(
      makeSkill({ metadata: { 'grid-execution': 'deep-research' } })
    )
    vi.mocked(repository.insertSkillSchedule).mockImplementation(async (values) =>
      makeSchedule(values)
    )
    const schedule = await createSkillSchedule(session, 'proj-1', {
      name: 'Deep',
      skillName: 'my-skill',
      scheduleCron: '0 9 * * 1',
    })
    expect(schedule.execution).toBe('deep-research')
    expect(schedule.nextRunAt).not.toBeNull()
  })
})

describe('updateSkillSchedule', () => {
  it('re-snapshots when the skill changes and recomputes next_run_at', async () => {
    vi.mocked(repository.findSkillSchedule).mockResolvedValue(makeSchedule())
    vi.mocked(repository.findSkillByName).mockResolvedValue(
      makeSkill({ name: 'other-skill', description: 'Other.' })
    )
    vi.mocked(repository.updateSkillSchedule).mockImplementation(async (id, orgId, values) =>
      makeSchedule(values)
    )
    const updated = await updateSkillSchedule(session, 'proj-1', 'schedule-1', {
      skillName: 'other-skill',
    })
    expect(updated.skillSnapshot.name).toBe('other-skill')
    expect(updated.skillSnapshot.description).toBe('Other.')
  })

  it('vetoes enabling a cron on a non-schedulable skill', async () => {
    vi.mocked(repository.findSkillSchedule).mockResolvedValue(
      makeSchedule({
        skillSnapshot: {
          ...makeSchedule().skillSnapshot,
          metadata: { 'grid-schedulable': 'false' },
        },
      })
    )
    vi.mocked(repository.findSkillByName).mockResolvedValue(
      makeSkill({ metadata: { 'grid-schedulable': 'false' } })
    )
    await expect(
      updateSkillSchedule(session, 'proj-1', 'schedule-1', { scheduleCron: '0 9 * * 1' })
    ).rejects.toBeInstanceOf(BadRequestError)
  })
})

describe('runSkillScheduleNow', () => {
  it('409s when the schedule is disabled', async () => {
    vi.mocked(repository.findSkillSchedule).mockResolvedValue(makeSchedule({ enabled: false }))
    await expect(runSkillScheduleNow(session, 'proj-1', 'schedule-1')).rejects.toBeInstanceOf(
      ConflictError
    )
  })

  it('fires through the single path and returns the run', async () => {
    vi.mocked(repository.findSkillSchedule).mockResolvedValue(makeSchedule())
    const run = await runSkillScheduleNow(session, 'proj-1', 'schedule-1')
    expect(run.status).toBe('submitted')
    expect(submitSkillJob).toHaveBeenCalledTimes(1)
  })
})

describe('fireSkillSchedule', () => {
  it('submits a deterministic prompt embedding the full skill body', async () => {
    await fireSkillSchedule(makeSchedule(), 'manual', 'user_1')
    const payload = vi.mocked(submitSkillJob).mock.calls[0][0]
    expect(payload.skills).toEqual(['my-skill'])
    expect(payload.execution).toBe('chat')
    expect(payload.input).toContain('Body.')
    expect(payload.input).toContain('Führe den folgenden Skill verbindlich')
    expect(repository.insertSkillRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'submitted', trigger: 'manual', jobId: 'job-1' })
    )
    expect(repository.touchSkillScheduleLastRun).toHaveBeenCalled()
  })

  it('records a skipped run on a 429 admission cap and never throws', async () => {
    vi.mocked(submitSkillJob).mockRejectedValue(new SkillSubmitSkippedError('cap', 13))
    const run = await fireSkillSchedule(makeSchedule(), 'schedule', 'scheduler')
    expect(run.status).toBe('skipped')
    expect(run.detail).toContain('cap')
    expect(repository.insertSkillRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped', triggeredBy: 'scheduler' })
    )
  })

  it('records an error run on a submission failure and never throws', async () => {
    vi.mocked(submitSkillJob).mockRejectedValue(new SkillSubmitError('boom', 500))
    const run = await fireSkillSchedule(makeSchedule(), 'manual', 'user_1')
    expect(run.status).toBe('error')
    expect(run.detail).toContain('boom')
  })
})

describe('fireScheduledSkillSchedule', () => {
  it('returns disabled without firing when the schedule is off', async () => {
    const result = await fireScheduledSkillSchedule(makeSchedule({ enabled: false }))
    expect(result).toEqual({ fired: false, reason: 'disabled' })
    expect(submitSkillJob).not.toHaveBeenCalled()
  })

  it('records a skipped run when the org feature gate is off (fail-closed)', async () => {
    vi.mocked(enforcementOn).mockReturnValue(true)
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)
    const result = await fireScheduledSkillSchedule(makeSchedule())
    expect(result).toEqual({ fired: false, reason: 'feature-disabled' })
    expect(repository.insertSkillRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'skipped',
        detail: 'Skills feature disabled for organization',
      })
    )
  })

  it('fires with scheduler identity when the gate is on', async () => {
    vi.mocked(enforcementOn).mockReturnValue(true)
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
    const result = await fireScheduledSkillSchedule(makeSchedule())
    expect(result.fired).toBe(true)
    expect(submitSkillJob).toHaveBeenCalledTimes(1)
  })
})

describe('resolveSkillsForAgent', () => {
  it('merges platform + enabled org rows, org shadowing platform, disabled excluded', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({
        name: 'data-table-analysis',
        description: 'org shadow',
        metadata: { 'grid-execution': 'deep-research' },
      }),
      makeSkill({ id: 's2', name: 'disabled-skill', enabled: false }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('data-table-analysis')
    expect(skills[0].description).toBe('org shadow')
    expect(skills[0].metadata['grid-execution']).toBe('deep-research')
  })

  it('filters by grid-agents when an agent is named, absent meaning all', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'for-researcher', metadata: { 'grid-agents': 'deep_researcher' } }),
      makeSkill({ id: 's2', name: 'for-everyone' }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1', 'deep_researcher')
    expect(skills.map((s) => s.name)).toEqual(['data-table-analysis', 'for-researcher', 'for-everyone'])
    const { skills: other } = await resolveSkillsForAgent('org_1', 'chat_agent')
    expect(other.map((s) => s.name)).toEqual(['data-table-analysis', 'for-everyone'])
  })
})

describe('getSkillSchedule / listSkillSchedules', () => {
  it('404s on schedules outside the org', async () => {
    await expect(getSkillSchedule(session, 'proj-1', 'nope')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('returns the org-scoped schedules', async () => {
    vi.mocked(repository.listSkillSchedulesInProject).mockResolvedValue([makeSchedule()])
    const { schedules } = await listSkillSchedules(session, 'proj-1')
    expect(schedules).toHaveLength(1)
    expect(repository.listSkillSchedulesInProject).toHaveBeenCalledWith('proj-1', 'org_1')
  })
})