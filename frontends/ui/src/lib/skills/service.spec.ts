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
  listPublishedOfferRows: vi.fn(),
}))

vi.mock('./skill-category-repository', () => ({
  CATEGORIES_LIST_LIMIT: 100,
  listCategoriesForOrg: vi.fn(),
  findCategoryInScope: vi.fn(),
  findPlatformSkillCategory: vi.fn(),
  findOrgCategoryByName: vi.fn(),
  findPlatformSkillCategoryByName: vi.fn(),
  findOrgCategory: vi.fn(),
  insertCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
  orgCategoryValues: vi.fn((organizationId, values) => ({ ...values, organizationId })),
}))

import { canManageSkills } from '@/lib/authz/organizations'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import * as repository from './repository'
import * as categoryRepository from './skill-category-repository'
import * as platformRepository from './platform-repository'
import { findPlatformSkill, listPlatformSkills } from './platform-skills'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { PlatformSkillRow, Skill } from '@/lib/db/schema'
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  listSkillCategories,
  createSkillCategory,
  updateSkillCategory,
  deleteSkillCategory,
  resolveSkillSnapshot,
  resolveSkillsForAgent,
  resolveSelectableSkills,
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

/** A skill the platform OFFERS organizations — a chat-usable FILE starts ON. */
const CURATED_SKILL = {
  name: 'oib-fire-check',
  description: 'Checks the project against OIB fire safety.',
  body: '# Fire check\n\nAct as a fire-safety reviewer.',
  metadata: { 'grid-catalog': 'curated' },
  origin: 'platform' as const,
  collection: 'research' as const,
}

/** A deep-research-only FILE offer — starts OFF, never in the chat `/` menu. */
const DEEP_ONLY_SKILL = {
  name: 'forecast-analysis',
  description: 'Forecast evidence for a deep-research job.',
  body: '# Forecast\n\nUse execute.',
  metadata: { 'grid-catalog': 'curated', 'grid-agents': 'deep_researcher' },
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

/** A published `platform_skills` row — an OFFER unless a test says otherwise. */
function platformRow(overrides: Partial<PlatformSkillRow> = {}): PlatformSkillRow {
  const base: PlatformSkillRow = {
    id: 'ps-1',
    name: 'energy-check',
    description: 'Reviews the energy certificate.',
    body: 'Compare the certificate against OIB 6.',
    metadata: {},
    published: true,
    delivery: 'offer',
    categoryId: null,
    createdBy: 'owner',
    createdByEmail: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }
  return { ...base, ...overrides }
}

/**
 * A dashboard row the platform published — the one that used to carry
 * `delivery: 'standard'` and impose itself on every tenant. An ordinary offer
 * since migration 0088.
 */
const HOUSE_ROW = platformRow({
  id: 'ps-house',
  name: 'house-citation-style',
  description: 'Always cite the OIB paragraph number.',
  body: 'Cite every normative claim with its OIB paragraph.',
})

/** Publish `rows` into the fleet catalogue. */
function publishPlatformRows(rows: PlatformSkillRow[]): void {
  vi.mocked(platformRepository.listPublishedOfferRows).mockResolvedValue(
    rows.filter((row) => row.published)
  )
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
    categoryId: null,
    enabled: true,
    createdBy: 'user_1',
    createdByEmail: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
  }
  return { ...base, ...overrides }
}

/** A category row — platform-owned when organizationId is null. */
function makeCategory(
  overrides: Partial<{
    id: string
    organizationId: string | null
    name: string
    description: string | null
    slug: string | null
    sortOrder: number
  }> = {}
) {
  return {
    id: 'cat-1',
    organizationId: null,
    name: 'Recherche',
    description: null,
    slug: null,
    sortOrder: 0,
    createdBy: 'owner',
    createdByEmail: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(requireSkillsEnabled).mockReturnValue(null)
  vi.mocked(canManageSkills).mockReturnValue(true)
  vi.mocked(listPlatformSkills).mockReturnValue([PLATFORM_SKILL, CURATED_SKILL])
  vi.mocked(findPlatformSkill).mockImplementation(
    (name) => [PLATFORM_SKILL, CURATED_SKILL].find((skill) => skill.name === name) ?? null
  )
  vi.mocked(repository.listSkillsInOrg).mockResolvedValue([])
  // No decision recorded: chat-usable FILE offers default on; dashboard
  // offers and deep-research-only files default off; machinery is on.
  vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([])
  // The DB catalogue is empty unless a test publishes something into it.
  publishPlatformRows([])
  vi.mocked(repository.findSkill).mockResolvedValue(null)
  vi.mocked(repository.findSkillByName).mockResolvedValue(null)
  // No categories unless a test stands some up.
  vi.mocked(categoryRepository.listCategoriesForOrg).mockResolvedValue([])
  vi.mocked(categoryRepository.findCategoryInScope).mockResolvedValue(null)
  vi.mocked(categoryRepository.findOrgCategoryByName).mockResolvedValue(null)
  vi.mocked(categoryRepository.findOrgCategory).mockResolvedValue(null)
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

  it('starts a deep-research-only file offer OFF, and keeps it out of chat', async () => {
    vi.mocked(listPlatformSkills).mockReturnValue([PLATFORM_SKILL, CURATED_SKILL, DEEP_ONLY_SKILL])
    vi.mocked(findPlatformSkill).mockImplementation(
      (name) =>
        [PLATFORM_SKILL, CURATED_SKILL, DEEP_ONLY_SKILL].find((skill) => skill.name === name) ?? null
    )
    const { skills } = await listSkills(session)
    expect(skills.find((s) => s.name === 'forecast-analysis')).toMatchObject({
      enabled: false,
      origin: 'platform',
    })
    const { skills: chat } = await resolveSkillsForAgent('org_1', 'researcher')
    expect(chat.map((s) => s.name)).not.toContain('forecast-analysis')
    const { skills: deep } = await resolveSkillsForAgent('org_1', 'deep_researcher')
    expect(deep.map((s) => s.name)).not.toContain('forecast-analysis')
    const { skills: invocable } = await listInvocableSkills(session)
    expect(invocable.map((s) => s.name)).not.toContain('forecast-analysis')
  })

  it('starts a chat-usable file offer ON, and still lets the org switch it off', async () => {
    const { skills } = await listSkills(session)
    const offer = skills.find((s) => s.name === 'oib-fire-check')
    expect(offer).toMatchObject({ id: null, origin: 'platform', enabled: true })

    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('oib-fire-check', false),
    ])
    const { skills: after } = await listSkills(session)
    expect(after.find((s) => s.name === 'oib-fire-check')?.enabled).toBe(false)
  })

  /**
   * The delivery channel the platform dashboard writes into: a published
   * `platform_skills` row reaches every organization, with the body staying
   * ours. This is what replaced clone.
   */
  it('offers a published platform_skills row to the organization', async () => {
    publishPlatformRows([platformRow({ metadata: { 'grid-agents': 'deep_researcher' } })])
    const { skills } = await listSkills(session)
    const offer = skills.find((s) => s.name === 'energy-check')
    // The catalogue's id is deliberately NOT handed to a tenant: it addresses
    // the fleet's copy, and only the platform tier may write it.
    expect(offer).toMatchObject({ id: null, origin: 'platform', enabled: false })
    expect(offer?.body).toBe('Compare the certificate against OIB 6.')
    expect(offer?.metadata['grid-agents']).toBe('deep_researcher')
  })

  it('does not let a dashboard offer replace a shipped file of the same name', async () => {
    publishPlatformRows([
      platformRow({ name: 'oib-fire-check', body: 'DASHBOARD OVERRIDE' }),
    ])
    const { skills } = await listSkills(session)
    expect(skills.find((s) => s.name === 'oib-fire-check')?.body).toBe(CURATED_SKILL.body)
    const { skills: forTheRun } = await resolveSkillsForAgent('org_1')
    expect(forTheRun.find((s) => s.name === 'oib-fire-check')?.body).toBe(CURATED_SKILL.body)
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
   * The precedence both resolvers must agree on.
   *
   * `resolveSkillsForAgent` merges machinery LAST, so machinery wins a name
   * collision there. This function has to reach the same answer, or a curated
   * row carrying a builtin name would 404 a skill deep research always needs —
   * and only this path runs when a job pins its snapshot.
   */
  it('answers machinery without consulting the catalogue at all', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    const snapshot = await resolveSkillSnapshot('data-table-analysis', 'org_1')
    expect(snapshot.origin).toBe('platform')
    // In-memory, so the platform_skills query is never made for machinery.
    expect(platformRepository.listPublishedOfferRows).not.toHaveBeenCalled()
    expect(repository.listCuratedSkillActivations).not.toHaveBeenCalled()
  })

  /**
   * A job cannot newly attach an offer the org has not taken up. Jobs that
   * attached one BEFORE it was switched off keep running — they pinned a
   * snapshot at save time and never come back through here.
   */
  it('pins a chat-usable file offer without an activation row', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    expect((await resolveSkillSnapshot('oib-fire-check', 'org_1')).origin).toBe('platform')
  })

  it('will not pin a file offer the org has switched off', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('oib-fire-check', false),
    ])
    await expect(resolveSkillSnapshot('oib-fire-check', 'org_1')).rejects.toBeInstanceOf(
      NotFoundError
    )
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
    const shadowed = skills.find((s) => s.name === 'data-table-analysis')
    expect(shadowed?.description).toBe('org shadow')
    expect(shadowed?.metadata['grid-cards']).toBe('summary')
    expect(skills.map((s) => s.name)).not.toContain('disabled-skill')
    expect(skills.map((s) => s.name)).toContain('oib-fire-check')
  })

  it('filters by grid-agents when an agent is named, absent meaning all', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'for-researcher', metadata: { 'grid-agents': 'deep_researcher' } }),
      makeSkill({ id: 's2', name: 'for-everyone' }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1', 'deep_researcher')
    expect(skills.map((s) => s.name)).toEqual([
      'oib-fire-check',
      'data-table-analysis',
      'for-researcher',
      'for-everyone',
    ])
    const { skills: other } = await resolveSkillsForAgent('org_1', 'researcher')
    expect(other.map((s) => s.name)).toEqual(['oib-fire-check', 'data-table-analysis', 'for-everyone'])
  })

  it('ignores an unknown grid-agents name rather than hiding the skill from everyone', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'typo', metadata: { 'grid-agents': 'shallow_reseacher' } }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1', 'researcher')
    expect(skills.map((s) => s.name)).toContain('typo')
  })

  /**
   * `shallow_researcher` became `researcher`, and a stored row must keep meaning
   * the restriction its author chose.
   *
   * This is the pair to the test above, and the reason the alias could not
   * simply be a third known name: an ignored name reads as NO restriction, so a
   * chat-only skill would have started reaching deep research — silently, in
   * the widest possible direction. `0081_grid_agents_researcher_rename.sql`
   * rewrites the rows we can see; this covers the ones we cannot.
   */
  it('reads the retired shallow_researcher name as the researcher, both ways', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'chat-only', metadata: { 'grid-agents': 'shallow_researcher' } }),
    ])
    const { skills: forChat } = await resolveSkillsForAgent('org_1', 'researcher')
    expect(forChat.map((s) => s.name)).toContain('chat-only')

    const { skills: forDeep } = await resolveSkillsForAgent('org_1', 'deep_researcher')
    expect(forDeep.map((s) => s.name)).not.toContain('chat-only')
  })

  /**
   * The other direction: a backend still on the pre-rename build asks under the
   * old name for as long as a rolling deploy takes, and by then the migration
   * has already rewritten the rows. Canonicalising only the stored side would
   * black out every skill for that caller until the deploy finished.
   */
  it('answers a caller that still asks as shallow_researcher', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'chat-only', metadata: { 'grid-agents': 'researcher' } }),
      makeSkill({ id: 's2', name: 'deep-only', metadata: { 'grid-agents': 'deep_researcher' } }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1', 'shallow_researcher')
    expect(skills.map((s) => s.name)).toContain('chat-only')
    expect(skills.map((s) => s.name)).not.toContain('deep-only')
  })

  /**
   * The two halves of the platform set, and the whole reason they are separate.
   *
   * Machinery resolves for everyone — it is how deep research computes a table
   * and writes its report, not a capability anyone opted into. An offer
   * resolves only for an org that switched it on, so a switch on the Skills tab
   * actually reaches the agent instead of being decoration.
   */
  it('runs the machinery for every org and a chat-usable file offer by default', async () => {
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills.map((s) => s.name).sort()).toEqual(['data-table-analysis', 'oib-fire-check'])
  })

  it('drops an offer again when the org switches it back off', async () => {
    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('oib-fire-check', false),
    ])
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills.map((s) => s.name)).not.toContain('oib-fire-check')
  })
})

/**
 * The platform's STANDARD tier, and the fact that it is gone (migration 0088).
 *
 * It was a skill every organization ran, nobody was offered, and nobody outside
 * the platform dashboard could see or change — and `SkillRuntime` FORCED it, so
 * its body was loaded whether or not the model judged it relevant. That is an
 * instruction wearing a capability's clothes, and instructions now live in the
 * platform prompt and in each organization's own instruction block.
 *
 * Five properties used to hold here, each enforced by its own line: invisible,
 * default-on, non-targetable, non-shadowable, platform-owned. Every one of them
 * is asserted below in the NEGATIVE, because each was a handle the platform held
 * over a tenant and the removal is only real if none of them survives. A
 * published row is an ordinary offer now: listed, switchable, off until the org
 * says otherwise, and shadowable by the org's own skill of the same name.
 */
describe('a published platform row, after the standard tier was retired', () => {
  beforeEach(() => {
    publishPlatformRows([HOUSE_ROW])
  })

  it('does not run until the organization switches it on', async () => {
    expect(await repository.listCuratedSkillActivations('org_1')).toEqual([])
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills.map((s) => s.name)).not.toContain('house-citation-style')
  })

  it('appears on the org Skills tab, where the decision lives', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([makeSkill({ name: 'org-only' })])
    const { skills } = await listSkills(session)
    expect(skills.map((s) => s.name)).toContain('house-citation-style')
  })

  it('is switchable: the activation endpoint takes it and stores the decision', async () => {
    vi.mocked(repository.upsertCuratedSkillActivation).mockResolvedValue(
      activation('house-citation-style', true)
    )
    await expect(
      setCuratedSkillEnabled(session, 'house-citation-style', true)
    ).resolves.toBeTruthy()
    expect(repository.upsertCuratedSkillActivation).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'house-citation-style', enabled: true })
    )
  })

  it('runs once switched on, and carries no flag telling the backend to force it', async () => {
    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('house-citation-style', true),
    ])
    const { skills } = await resolveSkillsForAgent('org_1')
    const row = skills.find((s) => s.name === 'house-citation-style')
    expect(row).toMatchObject({
      origin: 'platform',
      body: 'Cite every normative claim with its OIB paragraph.',
    })
    // The key `SkillRuntime` read to force a skill. Its absence is the tier's.
    expect(Object.keys(row ?? {})).not.toContain('standard')
  })

  it('is shadowable: the org\'s own row of the same name wins', async () => {
    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('house-citation-style', true),
    ])
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'house-citation-style', body: 'Our own citation rule.' }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills.find((s) => s.name === 'house-citation-style')).toMatchObject({
      origin: 'org',
      body: 'Our own citation rule.',
    })
  })

  it('no longer reserves its name against a tenant authoring one', async () => {
    // The reservation existed because a standard row outranked an org row, so
    // authoring the name produced a green save and an agent that never followed
    // it. Nothing outranks the tenant now, so nothing is refused.
    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    vi.mocked(repository.insertSkill).mockImplementation(async (values) => makeSkill(values))
    await expect(
      createSkill(session, { name: 'house-citation-style', description: 'b', body: 'c' })
    ).resolves.toBeTruthy()
  })

  it('no longer refuses an edit to a row wearing its name', async () => {
    vi.mocked(repository.findSkill).mockResolvedValue(makeSkill({ name: 'house-citation-style' }))
    vi.mocked(repository.updateSkill).mockResolvedValue(
      makeSkill({ name: 'house-citation-style', body: 'NEW ORG BODY' })
    )
    await expect(
      updateSkill(session, 'skill-1', { body: 'NEW ORG BODY' })
    ).resolves.toBeTruthy()
  })

  it('is attachable to a job once the org has taken it up', async () => {
    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('house-citation-style', true),
    ])
    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    expect((await resolveSkillSnapshot('house-citation-style', 'org_1')).origin).toBe('platform')
  })

  /**
   * The collision no write boundary can catch: `assertNameIsFree` refuses a ROW
   * named after an existing builtin, but the other direction is a DEPLOY —
   * shipping a `SKILL.md` whose name matches a row published months ago. The
   * file is product code, the row is dashboard copy, so the file wins, in both
   * resolvers.
   */
  it('yields to the machinery when a builtin ships under its name', async () => {
    publishPlatformRows([
      platformRow({ ...HOUSE_ROW, name: 'data-table-analysis', body: 'DASHBOARD OVERRIDE' }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills.find((s) => s.name === 'data-table-analysis')?.body).toBe(PLATFORM_SKILL.body)

    // And the job path agrees, which is the half that actually runs on a save.
    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    expect((await resolveSkillSnapshot('data-table-analysis', 'org_1')).body).toBe(
      PLATFORM_SKILL.body
    )
  })

  /**
   * `grid-agents` still applies. That gate answers "which agent CAN run this",
   * which is a different question from who decides that it runs.
   */
  it('still respects grid-agents', async () => {
    publishPlatformRows([
      platformRow({ ...HOUSE_ROW, metadata: { 'grid-agents': 'deep_researcher' } }),
    ])
    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('house-citation-style', true),
    ])
    const { skills: deep } = await resolveSkillsForAgent('org_1', 'deep_researcher')
    expect(deep.map((s) => s.name)).toContain('house-citation-style')
    const { skills: chat } = await resolveSkillsForAgent('org_1', 'researcher')
    expect(chat.map((s) => s.name)).not.toContain('house-citation-style')
  })

  it('is in the pickers a person reads, because it is theirs to pick now', async () => {
    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('house-citation-style', true),
    ])
    const { skills: selectable } = await resolveSelectableSkills('org_1')
    expect(selectable.map((s) => s.name)).toContain('house-citation-style')

    const { skills: invocable } = await listInvocableSkills(session)
    expect(invocable.map((s) => s.name)).toContain('house-citation-style')
  })
})

describe('listInvocableSkills', () => {
  it('never lists pipeline machinery — those load on their own', async () => {
    const { skills } = await listInvocableSkills(session)
    expect(skills.map((s) => s.name)).not.toContain('data-table-analysis')
    expect(skills.map((s) => s.name)).toContain('oib-fire-check')
  })

  it('lists a hidden org skill — hidden is the live line, not the menu', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'house-voice', metadata: { 'grid-hidden': 'true' } }),
    ])
    const { skills } = await listInvocableSkills(session)
    expect(skills.map((s) => s.name)).toContain('house-voice')
  })

  it('does not list an offer the org switched off', async () => {
    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('oib-fire-check', false),
    ])
    const { skills } = await listInvocableSkills(session)
    expect(skills.map((s) => s.name)).not.toContain('oib-fire-check')
  })

  it('still lists an org row that shadows machinery, because that copy is theirs', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'data-table-analysis', description: 'org shadow' }),
    ])
    const { skills } = await listInvocableSkills(session)
    expect(skills.find((s) => s.name === 'data-table-analysis')).toMatchObject({
      origin: 'org',
      description: 'org shadow',
    })
  })

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

describe('skill categories', () => {
  it('lists platform categories before org categories, with their scope', async () => {
    // Repository order is the contract (platform first); the service maps it.
    vi.mocked(categoryRepository.listCategoriesForOrg).mockResolvedValue([
      makeCategory({ id: 'cat-1', name: 'Recherche', slug: 'research', sortOrder: 0 }),
      makeCategory({ id: 'cat-2', organizationId: 'org_1', name: 'Eigene', slug: null, sortOrder: 0 }),
    ])
    const { categories } = await listSkills(session)
    expect(categories.map((c) => c.name)).toEqual(['Recherche', 'Eigene'])
    expect(categories[0]).toMatchObject({ scope: 'platform', slug: 'research' })
    expect(categories[1]).toMatchObject({ scope: 'org' })
  })

  it('categories a builtin file offer by its collection slug', async () => {
    vi.mocked(categoryRepository.listCategoriesForOrg).mockResolvedValue([
      makeCategory({ id: 'cat-1', name: 'Recherche', slug: 'research' }),
    ])
    const { skills } = await listSkills(session)
    // CURATED_SKILL is a `research` file offer: no row, still categorized.
    expect(skills.find((s) => s.name === 'oib-fire-check')?.categoryId).toBe('cat-1')
  })

  it('keeps a dashboard row on its stored category', async () => {
    publishPlatformRows([platformRow({ categoryId: 'cat-9' })])
    const { skills } = await listSkills(session)
    expect(skills.find((s) => s.name === 'energy-check')?.categoryId).toBe('cat-9')
  })

  it('leaves file offers unsorted when no category carries their slug', async () => {
    const { skills } = await listSkills(session)
    expect(skills.find((s) => s.name === 'oib-fire-check')?.categoryId).toBeNull()
  })

  it('refuses a category outside the org on create', async () => {
    vi.mocked(categoryRepository.findCategoryInScope).mockResolvedValue(null)
    vi.mocked(repository.insertSkill).mockImplementation(async () => makeSkill())
    await expect(
      createSkill(session, { name: 'a', description: 'b', body: 'c', categoryId: 'cat-x' })
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(repository.insertSkill).not.toHaveBeenCalled()
  })

  it('assigns an org or platform category on create', async () => {
    vi.mocked(categoryRepository.findCategoryInScope).mockResolvedValue(
      makeCategory({ id: 'cat-1' })
    )
    vi.mocked(repository.insertSkill).mockImplementation(async (values) => makeSkill(values))
    const { skill } = await createSkill(session, {
      name: 'a',
      description: 'b',
      body: 'c',
      categoryId: 'cat-1',
    })
    expect(skill.categoryId).toBe('cat-1')
  })

  it('removes the category on an explicit null, keeps it on an omitted key', async () => {
    vi.mocked(repository.findSkill).mockResolvedValue(makeSkill({ categoryId: 'cat-1' }))
    vi.mocked(categoryRepository.findCategoryInScope).mockResolvedValue(
      makeCategory({ id: 'cat-2' })
    )
    vi.mocked(repository.updateSkill).mockImplementation(
      async (_id, _org, patch) => makeSkill({ categoryId: patch.categoryId ?? 'cat-1' })
    )
    await updateSkill(session, 'skill-1', { description: 'neu' })
    expect(vi.mocked(repository.updateSkill).mock.calls[0][2]).not.toHaveProperty('categoryId')
    expect(categoryRepository.findCategoryInScope).not.toHaveBeenCalled()
    await updateSkill(session, 'skill-1', { categoryId: 'cat-2' })
    expect(vi.mocked(repository.updateSkill).mock.calls[1][2]).toHaveProperty('categoryId', 'cat-2')
    await updateSkill(session, 'skill-1', { categoryId: null })
    expect(vi.mocked(repository.updateSkill).mock.calls[2][2]).toHaveProperty('categoryId', null)
  })
})

describe('skill category CRUD', () => {
  it('lists categories with their scope', async () => {
    vi.mocked(categoryRepository.listCategoriesForOrg).mockResolvedValue([
      makeCategory({ id: 'cat-1', name: 'Recherche', slug: 'research', sortOrder: 0 }),
      makeCategory({ id: 'cat-2', organizationId: 'org_1', name: 'Eigene', slug: null, sortOrder: 0 }),
    ])
    const { categories } = await listSkillCategories(session)
    expect(categories).toEqual([
      { id: 'cat-1', name: 'Recherche', description: null, slug: 'research', sortOrder: 0, scope: 'platform' },
      { id: 'cat-2', name: 'Eigene', description: null, slug: null, sortOrder: 0, scope: 'org' },
    ])
  })

  it('refuses a duplicate category name in the org', async () => {
    vi.mocked(categoryRepository.findOrgCategoryByName).mockResolvedValue(
      makeCategory({ organizationId: 'org_1', name: 'Eigene' })
    )
    vi.mocked(categoryRepository.insertCategory).mockImplementation(async (values) => ({
      ...makeCategory({ organizationId: 'org_1' }),
      ...values,
    }))
    await expect(createSkillCategory(session, { name: 'Eigene' })).rejects.toBeInstanceOf(
      ConflictError
    )
    expect(categoryRepository.insertCategory).not.toHaveBeenCalled()
  })

  it('creates, renames and removes an org category', async () => {
    vi.mocked(categoryRepository.findOrgCategoryByName).mockResolvedValue(null)
    vi.mocked(categoryRepository.insertCategory).mockImplementation(async (values) => ({
      ...makeCategory({ organizationId: 'org_1' }),
      ...values,
    }))
    const { category } = await createSkillCategory(session, { name: 'Eigene' })
    expect(category).toMatchObject({ name: 'Eigene', scope: 'org' })

    vi.mocked(categoryRepository.findOrgCategory).mockResolvedValue(
      makeCategory({ id: 'cat-9', organizationId: 'org_1', name: 'Eigene' })
    )
    vi.mocked(categoryRepository.updateCategory).mockImplementation(
      async (_id, patch) => ({ ...makeCategory({ id: 'cat-9', organizationId: 'org_1' }), ...patch, description: patch.description ?? null })
    )
    const renamed = await updateSkillCategory(session, 'cat-9', { name: 'Prüfungen' })
    expect(renamed.category.name).toBe('Prüfungen')

    vi.mocked(categoryRepository.deleteCategory).mockResolvedValue(true)
    await expect(deleteSkillCategory(session, 'cat-9')).resolves.toEqual({ deleted: true })
  })

  it('never addresses a platform category from the org path', async () => {
    vi.mocked(categoryRepository.findOrgCategory).mockResolvedValue(null)
    vi.mocked(categoryRepository.deleteCategory).mockResolvedValue(true)
    await expect(deleteSkillCategory(session, 'cat-1')).rejects.toBeInstanceOf(NotFoundError)
    expect(categoryRepository.deleteCategory).not.toHaveBeenCalled()
  })

  it('refuses a create past the list limit instead of silently dropping rows', async () => {
    vi.mocked(categoryRepository.findOrgCategoryByName).mockResolvedValue(null)
    vi.mocked(categoryRepository.listCategoriesForOrg).mockResolvedValue(
      Array.from({ length: 101 }, (_, index) =>
        makeCategory({ id: `cat-${index}`, name: `Kat ${index}` })
      )
    )
    vi.mocked(categoryRepository.insertCategory).mockImplementation(async (values) => ({
      ...makeCategory({ organizationId: 'org_1' }),
      ...values,
    }))
    await expect(createSkillCategory(session, { name: 'Eine zu viel' })).rejects.toBeInstanceOf(
      ConflictError
    )
    expect(categoryRepository.insertCategory).not.toHaveBeenCalled()
  })
})
