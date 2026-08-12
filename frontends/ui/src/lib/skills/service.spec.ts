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
  listCuratedSkillActivations: vi.fn(),
  upsertCuratedSkillActivation: vi.fn(),
}))

vi.mock('./platform-skills', () => ({
  listPlatformSkills: vi.fn(),
  findPlatformSkill: vi.fn(),
}))

vi.mock('./platform-repository', () => ({
  listPublishedPlatformSkillRows: vi.fn(),
}))

import { canManageSkills } from '@/lib/authz/organizations'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import * as repository from './repository'
import * as platformRepository from './platform-repository'
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
  setCuratedSkillEnabled,
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

/**
 * The pipeline's own machinery: no `grid-catalog`, so it is not an offer.
 * Never listed on the Skills tab, never switchable, always resolved.
 */
const PLATFORM_SKILL = {
  name: 'data-table-analysis',
  description: 'Analyze tables.',
  body: '# Data Table Analysis Skill\n\nCompute deterministically.',
  metadata: {},
  origin: 'platform' as const,
  collection: 'research' as const,
}

/** A skill the platform OFFERS organizations — off until one switches it on. */
const CURATED_SKILL = {
  name: 'oib-fire-check',
  description: 'Checks the project against OIB fire safety.',
  body: '# Fire check\n\nAct as a fire-safety reviewer.',
  metadata: { 'grid-catalog': 'curated' },
  origin: 'platform' as const,
  collection: 'research' as const,
}

/** The org switched `name` on (or off) — what the activations table holds. */
function activation(name: string, enabled: boolean) {
  return {
    organizationId: 'org_1',
    skillName: name,
    enabled,
    updatedBy: 'user_1',
    updatedByEmail: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }
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
  vi.mocked(listPlatformSkills).mockReturnValue([PLATFORM_SKILL, CURATED_SKILL])
  vi.mocked(findPlatformSkill).mockImplementation(
    (name) => [PLATFORM_SKILL, CURATED_SKILL].find((skill) => skill.name === name) ?? null
  )
  vi.mocked(repository.listSkillsInOrg).mockResolvedValue([])
  // No decision recorded: every curated skill is off, machinery is on.
  vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([])
  // The DB catalogue is empty unless a test publishes something into it.
  vi.mocked(platformRepository.listPublishedPlatformSkillRows).mockResolvedValue([])
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
  /**
   * The Skills tab is what an organization HAS, plus what it is offered.
   *
   * The pipeline's machinery used to be merged in here as equal rows, each
   * with a clone button — five instructions nobody installs, nobody can edit
   * and nobody can invoke from chat, in front of an org with two skills of its
   * own. It is gone from this list and still resolves for every run, which is
   * the pair of facts the next two tests hold apart.
   */
  it('lists org rows and the platform OFFERS, never the pipeline machinery', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ id: 'skill-2', name: 'org-only' }),
    ])
    const { skills } = await listSkills(session)
    expect(skills.map((s) => s.name)).toEqual(['oib-fire-check', 'org-only'])
    expect(skills.map((s) => s.name)).not.toContain('data-table-analysis')
    expect(skills.find((s) => s.name === 'org-only')?.id).toBe('skill-2')
  })

  it('offers a curated skill switched OFF until the org decides otherwise', async () => {
    const { skills } = await listSkills(session)
    const offer = skills.find((s) => s.name === 'oib-fire-check')
    // No id: it is still a file, and the switch addresses it by name.
    expect(offer).toMatchObject({ id: null, origin: 'platform', enabled: false })

    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('oib-fire-check', true),
    ])
    const { skills: after } = await listSkills(session)
    expect(after.find((s) => s.name === 'oib-fire-check')?.enabled).toBe(true)
  })

  /**
   * The delivery channel the platform dashboard writes into: a published
   * `platform_skills` row reaches every organization, with the body staying
   * ours. This is what replaced clone.
   */
  it('offers a published platform_skills row to the organization', async () => {
    vi.mocked(platformRepository.listPublishedPlatformSkillRows).mockResolvedValue([
      {
        id: 'ps-1',
        name: 'energy-check',
        description: 'Reviews the energy certificate.',
        body: 'Compare the certificate against OIB 6.',
        metadata: { 'grid-agents': 'deep_researcher' },
        published: true,
        createdBy: 'owner',
        createdByEmail: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ])
    const { skills } = await listSkills(session)
    const offer = skills.find((s) => s.name === 'energy-check')
    // The catalogue's id is deliberately NOT handed to a tenant: it addresses
    // the fleet's copy, and only the platform tier may write it.
    expect(offer).toMatchObject({ id: null, origin: 'platform', enabled: false })
    expect(offer?.body).toBe('Compare the certificate against OIB 6.')
    expect(offer?.metadata['grid-agents']).toBe('deep_researcher')
  })

  it('lets an org row shadow an offer of the same name, as it always has', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'oib-fire-check', description: 'org shadow' }),
    ])
    const { skills } = await listSkills(session)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ description: 'org shadow', origin: 'org' })
  })
})

describe('setCuratedSkillEnabled', () => {
  it('requires org:skills:manage', async () => {
    vi.mocked(canManageSkills).mockReturnValue(false)
    await expect(setCuratedSkillEnabled(session, 'oib-fire-check', true)).rejects.toBeInstanceOf(
      ForbiddenError
    )
  })

  it('stores the decision by name and reports the new state', async () => {
    vi.mocked(repository.upsertCuratedSkillActivation).mockResolvedValue(
      activation('oib-fire-check', true)
    )
    const { skill } = await setCuratedSkillEnabled(session, 'oib-fire-check', true)
    expect(repository.upsertCuratedSkillActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        skillName: 'oib-fire-check',
        enabled: true,
      })
    )
    expect(skill).toMatchObject({ name: 'oib-fire-check', enabled: true })
  })

  /**
   * The rule that keeps deep research working. Machinery is not an offer, so
   * it is not addressable — and the check is HERE, not only in the UI that
   * declines to draw a switch for it.
   */
  it('refuses to switch the pipeline machinery, and stores nothing', async () => {
    await expect(
      setCuratedSkillEnabled(session, 'data-table-analysis', false)
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(setCuratedSkillEnabled(session, 'no-such-skill', true)).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(repository.upsertCuratedSkillActivation).not.toHaveBeenCalled()
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

  /**
   * A job cannot newly attach an offer the org has not taken up. Jobs that
   * attached one BEFORE it was switched off keep running — they pinned a
   * snapshot at save time and never come back through here.
   */
  it('will not pin an offer the org has not switched on', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    await expect(resolveSkillSnapshot('oib-fire-check', 'org_1')).rejects.toBeInstanceOf(
      NotFoundError
    )

    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('oib-fire-check', true),
    ])
    expect((await resolveSkillSnapshot('oib-fire-check', 'org_1')).origin).toBe('platform')
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

  /**
   * The two halves of the platform set, and the whole reason they are separate.
   *
   * Machinery resolves for everyone — it is how deep research computes a table
   * and writes its report, not a capability anyone opted into. An offer
   * resolves only for an org that switched it on, so a switch on the Skills tab
   * actually reaches the agent instead of being decoration.
   */
  it('runs the machinery for every org and an offer only once switched on', async () => {
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills.map((s) => s.name)).toEqual(['data-table-analysis'])

    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('oib-fire-check', true),
    ])
    const { skills: after } = await resolveSkillsForAgent('org_1')
    // Offers are merged before machinery, so a curated row could never replace
    // the pipeline's own — sorted here because the ORDER is not the claim.
    expect(after.map((s) => s.name).sort()).toEqual(['data-table-analysis', 'oib-fire-check'])
  })

  it('drops an offer again when the org switches it back off', async () => {
    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('oib-fire-check', false),
    ])
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills.map((s) => s.name)).not.toContain('oib-fire-check')
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
