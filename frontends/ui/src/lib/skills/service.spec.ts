/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/organizations', () => ({
  canManageSkills: vi.fn().mockReturnValue(true),
}))

vi.mock('@/lib/authz/feature-flags', () => ({
  requireSkillsEnabled: vi.fn().mockReturnValue(null),
}))

vi.mock('./repository', () => ({
  insertSkill: vi.fn(),
  listSkillsInOrg: vi.fn(),
  findSkill: vi.fn(),
  findSkillByName: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
}))

vi.mock('./platform-skills', () => ({
  listPlatformSkills: vi.fn(),
  findPlatformSkill: vi.fn(),
}))

import { canManageSkills } from '@/lib/authz/organizations'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import * as repository from './repository'
import { findPlatformSkill, listPlatformSkills } from './platform-skills'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { Skill } from '@/lib/db/schema'
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  resolveSkillSnapshot,
  resolveSkillsForAgent,
  listInvocableSkills,
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

beforeEach(() => {
  vi.mocked(requireSkillsEnabled).mockReturnValue(null)
  vi.mocked(canManageSkills).mockReturnValue(true)
  vi.mocked(listPlatformSkills).mockReturnValue([PLATFORM_SKILL])
  vi.mocked(findPlatformSkill).mockImplementation((name) =>
    name === PLATFORM_SKILL.name ? PLATFORM_SKILL : null
  )
  vi.mocked(repository.listSkillsInOrg).mockResolvedValue([])
  vi.mocked(repository.findSkill).mockResolvedValue(null)
  vi.mocked(repository.findSkillByName).mockResolvedValue(null)
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

describe('resolveSkillSnapshot', () => {
  it('resolves org skills first, platform skills second, and 404s the rest', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(makeSkill())
    expect((await resolveSkillSnapshot('my-skill', 'org_1')).origin).toBe('org')

    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    expect((await resolveSkillSnapshot('data-table-analysis', 'org_1')).origin).toBe('platform')

    await expect(resolveSkillSnapshot('nope', 'org_1')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('resolveSkillsForAgent', () => {
  it('merges platform + enabled org rows, org shadowing platform, disabled excluded', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({
        name: 'data-table-analysis',
        description: 'org shadow',
        metadata: { 'grid-cards': 'summary' },
      }),
      makeSkill({ id: 's2', name: 'disabled-skill', enabled: false }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('data-table-analysis')
    expect(skills[0].description).toBe('org shadow')
    expect(skills[0].metadata['grid-cards']).toBe('summary')
  })

  it('filters by grid-agents when an agent is named, absent meaning all', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'for-researcher', metadata: { 'grid-agents': 'deep_researcher' } }),
      makeSkill({ id: 's2', name: 'for-everyone' }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1', 'deep_researcher')
    expect(skills.map((s) => s.name)).toEqual(['data-table-analysis', 'for-researcher', 'for-everyone'])
    const { skills: other } = await resolveSkillsForAgent('org_1', 'shallow_researcher')
    expect(other.map((s) => s.name)).toEqual(['data-table-analysis', 'for-everyone'])
  })

  it('ignores an unknown grid-agents name rather than hiding the skill from everyone', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'typo', metadata: { 'grid-agents': 'shallow_reseacher' } }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1', 'shallow_researcher')
    expect(skills.map((s) => s.name)).toContain('typo')
  })
})

describe('listInvocableSkills', () => {
  it('never offers a skill scoped away from the chat agent', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'sandbox-writer', metadata: { 'grid-agents': 'deep_researcher' } }),
    ])
    const { skills } = await listInvocableSkills(session)
    expect(skills.map((s) => s.name)).not.toContain('sandbox-writer')
  })

  it('carries only level-1 metadata — a menu never fetches a body', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([makeSkill({ name: 'a-skill' })])
    const { skills } = await listInvocableSkills(session)
    const entry = skills.find((s) => s.name === 'a-skill')
    expect(entry).toEqual({ name: 'a-skill', description: 'Does the thing.', origin: 'org' })
  })
})
