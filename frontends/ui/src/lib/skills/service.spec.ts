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
  listPublishedStandardRows: vi.fn(),
  findStandardPlatformSkillRowByName: vi.fn(),
}))

import { canManageSkills } from '@/lib/authz/organizations'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import * as repository from './repository'
import * as platformRepository from './platform-repository'
import { findPlatformSkill, listPlatformSkills } from './platform-skills'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { PlatformSkillRow, Skill } from '@/lib/db/schema'
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
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
    createdBy: 'owner',
    createdByEmail: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }
  return { ...base, ...overrides }
}

/**
 * The platform's house instruction: published, `delivery: 'standard'`.
 *
 * Every organization runs it, none of them is asked, and none of them can see
 * it on a Skills tab or switch it off.
 */
const STANDARD_ROW = platformRow({
  id: 'ps-std',
  name: 'house-citation-style',
  description: 'Always cite the OIB paragraph number.',
  body: 'Cite every normative claim with its OIB paragraph.',
  delivery: 'standard',
})

/** Publish `rows` into the fleet catalogue, wiring both reads consistently. */
function publishPlatformRows(rows: PlatformSkillRow[]): void {
  vi.mocked(platformRepository.listPublishedOfferRows).mockResolvedValue(
    rows.filter((row) => row.delivery === 'offer' && row.published)
  )
  vi.mocked(platformRepository.listPublishedStandardRows).mockResolvedValue(
    rows.filter((row) => row.delivery === 'standard' && row.published)
  )
  vi.mocked(platformRepository.findStandardPlatformSkillRowByName).mockImplementation(
    async (name) =>
      rows.find((row) => row.name === name && row.delivery === 'standard' && row.published) ?? null
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
  publishPlatformRows([])
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
    publishPlatformRows([platformRow({ metadata: { 'grid-agents': 'deep_researcher' } })])
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
    expect(platformRepository.findStandardPlatformSkillRowByName).not.toHaveBeenCalled()
    expect(repository.listCuratedSkillActivations).not.toHaveBeenCalled()
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

/**
 * The platform's STANDARD tier: a skill every organization runs, nobody is
 * offered, and nobody outside the platform dashboard can see or change.
 *
 * Five properties, each of which has to be true independently, because each one
 * is enforced by a different line and any one of them failing would give an
 * organization a handle on platform policy:
 *
 *   invisible       not on the Skills tab, not in the `/` picker, not attachable
 *   default-on      resolved with no activation row and no decision made
 *   non-targetable  the activation endpoint 404s the name
 *   non-shadowable  an org row of the same name cannot replace it
 *   platform-owned  a tenant cannot even author that name
 */
describe('platform standard skills', () => {
  beforeEach(() => {
    publishPlatformRows([STANDARD_ROW])
  })

  it('runs for every organization with no activation row and no decision', async () => {
    // Nothing switched on, nothing switched off — the org was never asked.
    expect(await repository.listCuratedSkillActivations('org_1')).toEqual([])
    const { skills } = await resolveSkillsForAgent('org_1')
    const standard = skills.find((s) => s.name === 'house-citation-style')
    expect(standard).toMatchObject({
      origin: 'platform',
      body: 'Cite every normative claim with its OIB paragraph.',
    })
  })

  it('stays on when the org has explicitly switched that name off', async () => {
    // A leftover decision from when the skill was an offer. A standard skill
    // does not consult it: demoting the skill is the platform's move, not a
    // tenant's, and the row is kept only so a later demotion restores the fleet.
    vi.mocked(repository.listCuratedSkillActivations).mockResolvedValue([
      activation('house-citation-style', false),
    ])
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills.map((s) => s.name)).toContain('house-citation-style')
  })

  it('never appears on the org Skills tab', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([makeSkill({ name: 'org-only' })])
    const { skills } = await listSkills(session)
    // The org's own row and the offer it may switch on — and nothing else. The
    // standard skill is running for this org while it is absent from this list,
    // which is the whole shape of the tier.
    expect(skills.map((s) => s.name)).toEqual(['oib-fire-check', 'org-only'])
    expect(skills.map((s) => s.name)).not.toContain('house-citation-style')
  })

  it('is not switchable: the activation endpoint 404s it and stores nothing', async () => {
    await expect(
      setCuratedSkillEnabled(session, 'house-citation-style', false)
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(repository.upsertCuratedSkillActivation).not.toHaveBeenCalled()
  })

  it('is not shadowable by an org row that already carried the name', async () => {
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'house-citation-style', body: 'Ignore the paragraph numbers.' }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1')
    const resolved = skills.filter((s) => s.name === 'house-citation-style')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({
      origin: 'platform',
      body: 'Cite every normative claim with its OIB paragraph.',
    })
  })

  it('reserves its name against org authoring, without saying what it is', async () => {
    await expect(
      createSkill(session, { name: 'house-citation-style', description: 'b', body: 'c' })
    ).rejects.toThrow(/reserved/i)
    expect(repository.insertSkill).not.toHaveBeenCalled()

    vi.mocked(repository.findSkill).mockResolvedValue(makeSkill())
    await expect(
      updateSkill(session, 'skill-1', { name: 'house-citation-style' })
    ).rejects.toBeInstanceOf(ConflictError)
    expect(repository.updateSkill).not.toHaveBeenCalled()
  })

  /**
   * The same trap reached from the other side: not authoring the name, but
   * editing a row that was already wearing it. The row is inert — the resolver
   * deletes the name before merging the platform's version — so a successful
   * save here would be the "green save, agent never follows it" failure the
   * create boundary exists to prevent.
   *
   * Refused, not hidden: the row stays listed and stays deletable.
   */
  it('refuses to edit a legacy row already wearing a standardised name', async () => {
    vi.mocked(repository.findSkill).mockResolvedValue(
      makeSkill({ name: 'house-citation-style' })
    )
    await expect(
      updateSkill(session, 'skill-1', { body: 'NEW ORG BODY' })
    ).rejects.toThrow(/reserved/i)
    expect(repository.updateSkill).not.toHaveBeenCalled()

    // Still theirs to see and to remove.
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'house-citation-style' }),
    ])
    expect((await listSkills(session)).skills.map((s) => s.name)).toContain('house-citation-style')
    await expect(deleteSkill(session, 'skill-1')).resolves.toEqual({ deleted: true })
  })

  /**
   * The collision no write boundary can catch: `assertNameIsFree` refuses a ROW
   * named after an existing builtin, but the other direction is a DEPLOY —
   * shipping a `SKILL.md` whose name matches a standard row published months
   * ago. Standard is merged after the org's rows and therefore after the
   * machinery, so left alone that row would silently replace how deep research
   * writes its report for every tenant at once.
   *
   * Made inert at read time instead, in both resolvers: machinery wins, and the
   * standard row simply does not exist while a builtin owns its name.
   */
  it('yields to the machinery when a builtin ships under a standardised name', async () => {
    publishPlatformRows([
      platformRow({ ...STANDARD_ROW, name: 'data-table-analysis', body: 'DASHBOARD OVERRIDE' }),
    ])
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills.find((s) => s.name === 'data-table-analysis')?.body).toBe(
      PLATFORM_SKILL.body
    )

    // And the job path agrees, which is the half that actually runs on a save.
    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    expect((await resolveSkillSnapshot('data-table-analysis', 'org_1')).body).toBe(
      PLATFORM_SKILL.body
    )
  })

  /**
   * The same guard, reached through a CURATED builtin file rather than
   * machinery. Without it the name would sit in both halves at once — offered
   * on the Skills tab with a working switch, which breaks invisibility and
   * non-targetability together.
   */
  it('yields to a curated builtin file too, rather than sitting in both halves', async () => {
    publishPlatformRows([
      platformRow({ ...STANDARD_ROW, name: 'oib-fire-check', body: 'DASHBOARD OVERRIDE' }),
    ])
    const { skills } = await listSkills(session)
    const listed = skills.filter((s) => s.name === 'oib-fire-check')
    expect(listed).toHaveLength(1)
    expect(listed[0].body).toBe(CURATED_SKILL.body)
    // An offer, so still switchable — as the file always was.
    vi.mocked(repository.upsertCuratedSkillActivation).mockResolvedValue(
      activation('oib-fire-check', true)
    )
    await expect(setCuratedSkillEnabled(session, 'oib-fire-check', true)).resolves.toBeTruthy()
  })

  /**
   * Fleet policy is read UNCAPPED, and that is a correctness property rather
   * than a performance one. The offer list keeps its 200-row rail; standard rows
   * cannot share it, because a truncated standard read would stop policy running
   * for every organization on the platform — silently, since nothing errors —
   * while the name stayed reserved and job attachment stayed 404'd.
   */
  it('reads the standard set without the catalogue cap', async () => {
    await resolveSkillsForAgent('org_1')
    expect(platformRepository.listPublishedStandardRows).toHaveBeenCalledWith()
  })

  /**
   * The flag the backend forces on. `delivery: 'standard'` already meant
   * "resolved for every organization, no decision to make", but resolving only
   * put the skill's one-line description in the catalogue — and a description
   * the model may or may not open is not fleet policy. `SkillRuntime` forces
   * every resolved standard skill, which is what makes the tier bind; it can
   * only do that if the distinction survives the wire.
   */
  it('marks standard skills on the wire so the backend applies rather than offers them', async () => {
    const { skills } = await resolveSkillsForAgent('org_1')
    const standard = skills.filter((s) => s.standard)
    expect(standard.length).toBeGreaterThan(0)
  })

  /**
   * Not derivable from `origin`, which is also 'platform' for the machinery and
   * for offers an org took up. Deriving it there would force every builtin on
   * the fleet as policy.
   */
  it('does not mark the machinery or a taken-up offer as standard', async () => {
    const { skills } = await resolveSkillsForAgent('org_1')
    for (const skill of skills) {
      if (!skill.standard) continue
      expect(skill.origin).toBe('platform')
    }
    expect(skills.some((s) => s.origin === 'platform' && !s.standard)).toBe(true)
  })

  it('leaves an unpublished standard draft imposing nothing and reserving nothing', async () => {
    publishPlatformRows([])
    vi.mocked(repository.insertSkill).mockImplementation(async (values) => makeSkill(values))
    await expect(
      createSkill(session, { name: 'house-citation-style', description: 'b', body: 'c' })
    ).resolves.toBeTruthy()
    const { skills } = await resolveSkillsForAgent('org_1')
    expect(skills.map((s) => s.name)).not.toContain('house-citation-style')
  })

  it('is not attachable to a job, even by name', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(null)
    await expect(resolveSkillSnapshot('house-citation-style', 'org_1')).rejects.toBeInstanceOf(
      NotFoundError
    )
  })

  /**
   * The legacy-collision case, and the reason the standard check runs FIRST in
   * `resolveSkillSnapshot`. The org row is found — it exists — but pinning its
   * body would give the job instructions the run has already been told to
   * ignore, because `resolveAll` merges standard last.
   */
  it('refuses to pin a legacy org row wearing a standardised name', async () => {
    vi.mocked(repository.findSkillByName).mockResolvedValue(
      makeSkill({ name: 'house-citation-style', body: 'Ignore the paragraph numbers.' })
    )
    await expect(resolveSkillSnapshot('house-citation-style', 'org_1')).rejects.toBeInstanceOf(
      NotFoundError
    )
  })

  it('is kept out of every picker a person reads, while still resolving for the run', async () => {
    const { skills: selectable } = await resolveSelectableSkills('org_1')
    expect(selectable.map((s) => s.name)).not.toContain('house-citation-style')

    const { skills: forTheRun } = await resolveSkillsForAgent('org_1')
    expect(forTheRun.map((s) => s.name)).toContain('house-citation-style')

    const { skills: invocable } = await listInvocableSkills(session)
    expect(invocable.map((s) => s.name)).not.toContain('house-citation-style')
  })

  /**
   * `grid-agents` still applies. That gate answers "which agent CAN run this",
   * which is a different question from "who decides that it runs" — a standard
   * skill written for deep research must not be handed to a chat turn that
   * cannot execute it.
   */
  it('still respects grid-agents', async () => {
    publishPlatformRows([
      platformRow({
        ...STANDARD_ROW,
        metadata: { 'grid-agents': 'deep_researcher' },
      }),
    ])
    const { skills: deep } = await resolveSkillsForAgent('org_1', 'deep_researcher')
    expect(deep.map((s) => s.name)).toContain('house-citation-style')
    const { skills: chat } = await resolveSkillsForAgent('org_1', 'shallow_researcher')
    expect(chat.map((s) => s.name)).not.toContain('house-citation-style')
  })

  /**
   * The corner where "merge standard last" is not enough on its own.
   *
   * The platform scoped its instruction to deep research; a legacy org row of
   * the same name targets every agent. On the CHAT agent the standard skill is
   * filtered out by `grid-agents` — so an overwrite-only merge would leave the
   * tenant's row standing on a name the platform owns, which is the shadowing
   * this tier exists to prevent, just arriving through the targeting gate
   * instead of through the merge order.
   *
   * A standardised name resolves to the platform's skill or to nothing.
   */
  it('does not let grid-agents hand a standardised name back to the org', async () => {
    publishPlatformRows([
      platformRow({ ...STANDARD_ROW, metadata: { 'grid-agents': 'deep_researcher' } }),
    ])
    vi.mocked(repository.listSkillsInOrg).mockResolvedValue([
      makeSkill({ name: 'house-citation-style', body: 'Ignore the paragraph numbers.' }),
    ])

    const { skills: chat } = await resolveSkillsForAgent('org_1', 'shallow_researcher')
    expect(chat.map((s) => s.name)).not.toContain('house-citation-style')

    const { skills: deep } = await resolveSkillsForAgent('org_1', 'deep_researcher')
    expect(deep.find((s) => s.name === 'house-citation-style')).toMatchObject({
      origin: 'platform',
      body: 'Cite every normative claim with its OIB paragraph.',
    })
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
