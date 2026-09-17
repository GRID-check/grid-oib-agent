import { describe, expect, test } from 'vitest'
import type { SkillCategoryListItem, SkillListItem } from '@/adapters/api/skills-client'
import { groupSkillsByCategory, matchesSkillQuery } from './skill-categories'

const category = (overrides: Partial<SkillCategoryListItem> = {}): SkillCategoryListItem => ({
  id: 'cat-1',
  name: 'Recherche',
  description: null,
  slug: 'research',
  sortOrder: 0,
  scope: 'platform',
  ...overrides,
})

const skill = (overrides: Partial<SkillListItem> = {}): SkillListItem => ({
  id: 'skill-1',
  name: 'acoustic-report',
  description: 'Drafts the acoustic compliance report.',
  body: 'Body.',
  metadata: {},
  origin: 'org',
  enabled: true,
  clonedFrom: null,
  categoryId: null,
  createdAt: null,
  updatedAt: null,
  ...overrides,
})

describe('groupSkillsByCategory', () => {
  test('orders groups by category order, unsorted last', () => {
    const groups = groupSkillsByCategory(
      [
        skill({ id: 'a', name: 'a', categoryId: null }),
        skill({ id: 'b', name: 'b', categoryId: 'cat-2' }),
        skill({ id: 'c', name: 'c', categoryId: 'cat-1' }),
      ],
      [
        category({ id: 'cat-1', name: 'Recherche' }),
        category({ id: 'cat-2', name: 'Eigene', scope: 'org', slug: null }),
      ],
    )
    expect(groups.map((group) => group.category?.name ?? null)).toEqual([
      'Recherche',
      'Eigene',
      null,
    ])
    expect(groups[0].skills.map((s) => s.name)).toEqual(['c'])
  })

  test('drops empty categories and reads a deleted category as unsorted', () => {
    const groups = groupSkillsByCategory(
      [skill({ name: 'orphan', categoryId: 'cat-gone' }), skill({ name: 'plain' })],
      [category({ id: 'cat-1', name: 'Recherche' }), category({ id: 'cat-2', name: 'Leer' })],
    )
    // Neither category has members; both skills close the list unsorted.
    expect(groups).toHaveLength(1)
    expect(groups[0].category).toBeNull()
    expect(groups[0].skills.map((s) => s.name).sort()).toEqual(['orphan', 'plain'])
  })

  test('an empty skill list groups to nothing', () => {
    expect(groupSkillsByCategory([], [category()])).toEqual([])
  })
})

describe('matchesSkillQuery', () => {
  test('an empty query matches everything', () => {
    expect(matchesSkillQuery(skill(), '')).toBe(true)
    expect(matchesSkillQuery(skill(), '   ')).toBe(true)
  })

  test('matches name or description, case-folded', () => {
    expect(matchesSkillQuery(skill(), 'ACOUSTIC')).toBe(true)
    expect(matchesSkillQuery(skill(), 'compliance')).toBe(true)
    expect(matchesSkillQuery(skill(), 'brandschutz')).toBe(false)
  })
})
