/**
 * @vitest-environment node
 *
 * Platform → Skills: the fleet-wide curated catalogue.
 *
 * There is no authorization test here on purpose. This service takes no session
 * and makes no authorization claim: the platform-owner gate lives in
 * `platformApiRoute`, which runs BEFORE the handler (ADR-0016/0038), and
 * asserting it here would test a mock rather than the gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./platform-repository', () => ({
  listPlatformSkillRows: vi.fn(),
  listPublishedOfferRows: vi.fn(),
  listPublishedStandardRows: vi.fn(),
  findPlatformSkillRow: vi.fn(),
  findPlatformSkillRowByName: vi.fn(),
  insertPlatformSkillRow: vi.fn(),
  updatePlatformSkillRow: vi.fn(),
  deletePlatformSkillRow: vi.fn(),
}))

vi.mock('./platform-skills', () => ({
  findPlatformSkill: vi.fn(),
}))

vi.mock('./skill-category-repository', () => ({
  listPlatformSkillCategories: vi.fn(),
  findPlatformSkillCategory: vi.fn(),
  findPlatformSkillCategoryByName: vi.fn(),
  insertCategory: vi.fn(),
  updateCategory: vi.fn(),
  deleteCategory: vi.fn(),
}))

import * as repository from './platform-repository'
import * as categoryRepository from './skill-category-repository'
import { findPlatformSkill } from './platform-skills'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import type { PlatformSkillRow } from '@/lib/db/schema'
import {
  createPlatformSkill,
  createPlatformSkillCategory,
  deletePlatformSkill,
  deletePlatformSkillCategory,
  listPlatformSkillCategories,
  listPlatformSkills,
  updatePlatformSkill,
  updatePlatformSkillCategory,
} from './platform-service'

const author = { userId: 'user_1', email: 'owner@example.com' }

function makeRow(overrides: Partial<PlatformSkillRow> = {}): PlatformSkillRow {
  return {
    id: 'ps-1',
    name: 'oib-fire-check',
    description: 'Checks the project against OIB fire safety.',
    body: 'Act as a fire-safety reviewer.',
    metadata: {},
    published: false,
    delivery: 'offer',
    categoryId: null,
    createdBy: 'user_1',
    createdByEmail: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

function makeCategory(
  overrides: Partial<{
    id: string
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
    slug: 'research',
    sortOrder: 0,
    createdBy: 'owner',
    createdByEmail: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(findPlatformSkill).mockReturnValue(null)
  vi.mocked(repository.findPlatformSkillRowByName).mockResolvedValue(null)
  vi.mocked(repository.findPlatformSkillRow).mockResolvedValue(null)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('listPlatformSkills', () => {
  it('returns the whole catalogue, drafts included', async () => {
    vi.mocked(repository.listPlatformSkillRows).mockResolvedValue([
      makeRow(),
      makeRow({ id: 'ps-2', name: 'energy-check', published: true }),
    ])
    const { skills } = await listPlatformSkills()
    expect(skills.map((s) => [s.name, s.published])).toEqual([
      ['oib-fire-check', false],
      ['energy-check', true],
    ])
  })
})

describe('createPlatformSkill', () => {
  it('creates a DRAFT unless publishing was asked for', async () => {
    vi.mocked(repository.insertPlatformSkillRow).mockImplementation(async (values) =>
      makeRow(values as Partial<PlatformSkillRow>)
    )
    const { skill } = await createPlatformSkill(
      { name: 'oib-fire-check', description: 'd', body: 'b' },
      author
    )
    expect(skill.published).toBe(false)
    expect(repository.insertPlatformSkillRow).toHaveBeenCalledWith(
      expect.objectContaining({ published: false, createdBy: 'user_1' })
    )
  })

  /**
   * The second closed default, and the one that decides whether an organization
   * gets a choice. A skill that says nothing about its audience is an OFFER —
   * imposing on the fleet has to be a word somebody wrote.
   */
  it('creates an OFFER unless standard delivery was asked for', async () => {
    vi.mocked(repository.insertPlatformSkillRow).mockImplementation(async (values) =>
      makeRow(values as Partial<PlatformSkillRow>)
    )
    const { skill } = await createPlatformSkill(
      { name: 'oib-fire-check', description: 'd', body: 'b' },
      author
    )
    expect(skill.delivery).toBe('offer')

    const { skill: standard } = await createPlatformSkill(
      { name: 'house-style', description: 'd', body: 'b', delivery: 'standard' },
      author
    )
    expect(standard.delivery).toBe('standard')
    expect(repository.insertPlatformSkillRow).toHaveBeenLastCalledWith(
      expect.objectContaining({ delivery: 'standard' })
    )
  })

  it('conflicts on a duplicate curated name', async () => {
    vi.mocked(repository.findPlatformSkillRowByName).mockResolvedValue(makeRow())
    await expect(
      createPlatformSkill({ name: 'oib-fire-check', description: 'd', body: 'b' }, author)
    ).rejects.toBeInstanceOf(ConflictError)
    expect(repository.insertPlatformSkillRow).not.toHaveBeenCalled()
  })

  /**
   * The rule that protects deep research from the dashboard.
   *
   * A curated skill sharing a name with the pipeline's machinery would shadow
   * that machinery in the backend resolver for every org that switched the
   * curated one on — silently replacing how a report gets written with whatever
   * was typed here. The catalogue is the wrong place to discover that.
   */
  it('refuses a name that belongs to a builtin', async () => {
    vi.mocked(findPlatformSkill).mockReturnValue({
      name: 'long-form-report-writer',
      description: 'Machinery.',
      body: 'b',
      metadata: {},
      collection: 'synthesis',
    })
    await expect(
      createPlatformSkill({ name: 'long-form-report-writer', description: 'd', body: 'b' }, author)
    ).rejects.toBeInstanceOf(ConflictError)
    expect(repository.insertPlatformSkillRow).not.toHaveBeenCalled()
  })
})

describe('updatePlatformSkill', () => {
  it('publishes without touching anything else', async () => {
    vi.mocked(repository.findPlatformSkillRow).mockResolvedValue(makeRow())
    vi.mocked(repository.updatePlatformSkillRow).mockResolvedValue(makeRow({ published: true }))

    const { skill } = await updatePlatformSkill('ps-1', { published: true })
    expect(skill.published).toBe(true)
    expect(repository.updatePlatformSkillRow).toHaveBeenCalledWith(
      'ps-1',
      expect.objectContaining({ published: true })
    )
  })

  it('re-checks the name on a rename, against another curated row', async () => {
    vi.mocked(repository.findPlatformSkillRow).mockResolvedValue(makeRow())
    vi.mocked(repository.findPlatformSkillRowByName).mockResolvedValue(makeRow({ id: 'ps-9' }))
    await expect(updatePlatformSkill('ps-1', { name: 'taken' })).rejects.toBeInstanceOf(
      ConflictError
    )
    expect(repository.updatePlatformSkillRow).not.toHaveBeenCalled()
  })

  it('re-checks the name on a rename against BUILTINS too', async () => {
    vi.mocked(repository.findPlatformSkillRow).mockResolvedValue(makeRow())
    vi.mocked(findPlatformSkill).mockImplementation((name) =>
      name === 'long-form-report-writer'
        ? {
            name: 'long-form-report-writer',
            description: 'Machinery.',
            body: 'b',
            metadata: {},
            collection: 'synthesis',
          }
        : null
    )
    await expect(
      updatePlatformSkill('ps-1', { name: 'long-form-report-writer' })
    ).rejects.toBeInstanceOf(ConflictError)
    expect(repository.updatePlatformSkillRow).not.toHaveBeenCalled()
  })

  it('lets a row keep its own name', async () => {
    vi.mocked(repository.findPlatformSkillRow).mockResolvedValue(makeRow())
    vi.mocked(repository.updatePlatformSkillRow).mockResolvedValue(makeRow({ description: 'new' }))
    const { skill } = await updatePlatformSkill('ps-1', {
      name: 'oib-fire-check',
      description: 'new',
    })
    expect(skill.description).toBe('new')
  })

  /**
   * Promotion and demotion are the same call, and neither touches the document.
   * A standard skill is the same SKILL.md as the offer it was a moment ago — the
   * only thing that changed is who is running it.
   */
  it('moves a skill between the two deliveries', async () => {
    vi.mocked(repository.findPlatformSkillRow).mockResolvedValue(makeRow({ published: true }))
    vi.mocked(repository.updatePlatformSkillRow).mockResolvedValue(
      makeRow({ published: true, delivery: 'standard' })
    )
    const { skill } = await updatePlatformSkill('ps-1', { delivery: 'standard' })
    expect(skill.delivery).toBe('standard')
    expect(repository.updatePlatformSkillRow).toHaveBeenCalledWith(
      'ps-1',
      expect.objectContaining({ delivery: 'standard' })
    )
    // The body, description and metadata are not in the patch: nothing about the
    // instruction itself changes when its audience does.
    const [, patch] = vi.mocked(repository.updatePlatformSkillRow).mock.calls[0]
    expect(patch).not.toHaveProperty('body')
    expect(patch).not.toHaveProperty('published')
  })

  it('404s an unknown id', async () => {
    await expect(updatePlatformSkill('nope', { published: true })).rejects.toBeInstanceOf(
      NotFoundError
    )
  })
})

describe('deletePlatformSkill', () => {
  it('withdraws the skill and 404s an unknown id', async () => {
    vi.mocked(repository.deletePlatformSkillRow).mockResolvedValue(true)
    await expect(deletePlatformSkill('ps-1')).resolves.toEqual({ deleted: true })

    vi.mocked(repository.deletePlatformSkillRow).mockResolvedValue(false)
    await expect(deletePlatformSkill('ps-1')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('platform skill categories', () => {
  it('lists the platform categories with their scope', async () => {
    vi.mocked(categoryRepository.listPlatformSkillCategories).mockResolvedValue([
      makeCategory(),
    ])
    const { categories } = await listPlatformSkillCategories()
    expect(categories).toEqual([
      {
        id: 'cat-1',
        name: 'Recherche',
        description: null,
        slug: 'research',
        sortOrder: 0,
        scope: 'platform',
      },
    ])
  })

  it('creates on a free name and refuses a taken one', async () => {
    vi.mocked(categoryRepository.findPlatformSkillCategoryByName).mockResolvedValue(null)
    vi.mocked(categoryRepository.insertCategory).mockImplementation(async (values) => ({
      ...makeCategory(),
      ...values,
    }))
    const { category } = await createPlatformSkillCategory({ name: 'BIM' }, author)
    expect(category).toMatchObject({ name: 'BIM', scope: 'platform' })

    vi.mocked(categoryRepository.findPlatformSkillCategoryByName).mockResolvedValue(
      makeCategory({ name: 'BIM' })
    )
    await expect(createPlatformSkillCategory({ name: 'BIM' }, author)).rejects.toBeInstanceOf(
      ConflictError
    )
  })

  it('renames and removes, 404ing unknown ids', async () => {
    vi.mocked(categoryRepository.findPlatformSkillCategoryByName).mockResolvedValue(null)
    vi.mocked(categoryRepository.findPlatformSkillCategory).mockResolvedValue(
      makeCategory({ id: 'cat-9', name: 'Alt' })
    )
    vi.mocked(categoryRepository.updateCategory).mockImplementation(async (_id, patch) => ({
      ...makeCategory({ id: 'cat-9', name: 'Alt' }),
      ...patch,
      description: patch.description ?? null,
    }))
    const renamed = await updatePlatformSkillCategory('cat-9', { name: 'Neu' })
    expect(renamed.category.name).toBe('Neu')

    vi.mocked(categoryRepository.findPlatformSkillCategory).mockResolvedValue(null)
    await expect(updatePlatformSkillCategory('cat-x', { name: 'Neu' })).rejects.toBeInstanceOf(
      NotFoundError
    )
    vi.mocked(categoryRepository.findPlatformSkillCategory).mockResolvedValue(
      makeCategory({ id: 'cat-9', name: 'Neu' })
    )
    vi.mocked(categoryRepository.deleteCategory).mockResolvedValue(true)
    await expect(deletePlatformSkillCategory('cat-9')).resolves.toEqual({ deleted: true })
  })

  it('assigns catalogue rows to platform categories only', async () => {
    vi.mocked(categoryRepository.findPlatformSkillCategory).mockResolvedValue(
      makeCategory({ id: 'cat-1' })
    )
    vi.mocked(repository.insertPlatformSkillRow).mockImplementation(async (values) => ({
      ...makeRow(),
      ...values,
    }))
    const { skill } = await createPlatformSkill(
      {
        name: 'oib-fire-check',
        description: 'd',
        body: 'b',
        categoryId: 'cat-1',
      },
      author
    )
    expect(skill.categoryId).toBe('cat-1')

    vi.mocked(categoryRepository.findPlatformSkillCategory).mockResolvedValue(null)
    await expect(
      createPlatformSkill({ name: 'x', description: 'd', body: 'b', categoryId: 'cat-x' }, author)
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
