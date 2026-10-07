/**
 * How alike two projects are (docs/design/cross-project-escalation.md): the
 * Bundesland outweighs everything else (it decides the OIB edition and the
 * Bauordnung), the Gebäudeklasse comes next, a neighbouring class still counts
 * a little, and malformed facts read as unknown rather than throwing.
 */

import { describe, expect, it } from 'vitest'
import type { Project } from '@/lib/db/schema'
import { rankBySimilarity, sharedTraits, similarity, similarityFacts } from './similarity'

type Profile = Project['profile']

function profile(facts: Record<string, unknown>): Profile {
  return {
    facts: Object.fromEntries(
      Object.entries(facts).map(([key, value]) => [
        key,
        { value: value as string, confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: '' },
      ])
    ),
    goals: {},
    unknowns: [],
    assumptions: {},
  }
}

const here = similarityFacts(
  profile({ bundesland: 'Niederösterreich', gebaeudeklasse: 'GK 4', bauweise: 'Holzbau', nutzungen: ['Wohnen', 'Büro'] })
)

describe('similarityFacts', () => {
  it('reads the class from a number or any spelling with a digit, and treats anything else as unknown', () => {
    expect(similarityFacts(profile({ gebaeudeklasse: 4 })).gebaeudeklasse).toBe(4)
    expect(similarityFacts(profile({ gebaeudeklasse: 'GK4' })).gebaeudeklasse).toBe(4)
    expect(similarityFacts(profile({ gebaeudeklasse: 'unklar' })).gebaeudeklasse).toBeNull()
    expect(similarityFacts(profile({ bundesland: 42, nutzungen: 'Wohnen' }))).toMatchObject({
      bundesland: null,
      nutzungen: ['wohnen'],
    })
  })
})

describe('similarity', () => {
  it('weighs the same Bundesland above any single trait, and below class, construction and uses together', () => {
    const at = (facts: Record<string, unknown>) => similarity(here, similarityFacts(profile(facts)))
    const sameLand = at({ bundesland: 'niederösterreich' })
    expect(sameLand).toBeGreaterThan(at({ gebaeudeklasse: 4 }))
    expect(sameLand).toBeGreaterThan(at({ bauweise: 'holzbau' }))
    expect(at({ gebaeudeklasse: 4, bauweise: 'holzbau', nutzungen: ['wohnen', 'büro'] })).toBeGreaterThan(sameLand)
  })

  it('counts a neighbouring class a little and a distant one not at all', () => {
    const at = (gk: number) => similarity(here, similarityFacts(profile({ gebaeudeklasse: gk })))
    expect(at(4)).toBeGreaterThan(at(5))
    expect(at(5)).toBeGreaterThan(at(2))
    expect(at(2)).toBe(0)
  })

  it('is 0 when either side knows nothing', () => {
    expect(similarity(similarityFacts(profile({})), here)).toBe(0)
    expect(similarity(here, similarityFacts(null as unknown as Profile))).toBe(0)
  })
})

describe('sharedTraits', () => {
  it('names what the two have in common, for the catalog line', () => {
    const other = similarityFacts(
      profile({ bundesland: 'Niederösterreich', gebaeudeklasse: 4, bauweise: 'Massivbau', nutzungen: ['Wohnen'] })
    )
    expect(sharedTraits(here, other)).toEqual(['niederösterreich', 'GK 4', 'wohnen'])
  })
})

describe('rankBySimilarity', () => {
  it('orders the most alike first and keeps the given order among equals', () => {
    const projects = [
      { id: 'wien', profile: profile({ bundesland: 'Wien', gebaeudeklasse: 4 }) },
      { id: 'noe-gk2', profile: profile({ bundesland: 'Niederösterreich', gebaeudeklasse: 2 }) },
      { id: 'noe-gk4', profile: profile({ bundesland: 'Niederösterreich', gebaeudeklasse: 4 }) },
      { id: 'none-a', profile: profile({}) },
      { id: 'none-b', profile: profile({}) },
    ]
    const current = profile({ bundesland: 'Niederösterreich', gebaeudeklasse: 4 })

    expect(rankBySimilarity(current, projects).map((project) => project.id)).toEqual([
      'noe-gk4',
      'noe-gk2',
      'wien',
      'none-a',
      'none-b',
    ])
    expect(rankBySimilarity(null, projects).map((project) => project.id)).toEqual(projects.map((project) => project.id))
  })
})
