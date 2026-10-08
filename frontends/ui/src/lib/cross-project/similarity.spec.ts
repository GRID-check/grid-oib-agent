/**
 * How alike two projects are (docs/design/cross-project-escalation.md): the
 * Bundesland outweighs everything else (it decides the OIB edition and the
 * Bauordnung), the Gebäudeklasse comes next, a neighbouring class still counts
 * a little, and malformed facts read as unknown rather than throwing.
 */

import { describe, expect, it } from 'vitest'
import type { Project } from '@/lib/db/schema'
import { buildIntakeProfile, projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { SIMILARITY_WEIGHTS, bundeslandOf, rankBySimilarity, sharedTraits, similarity, similarityFacts } from './similarity'

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
  profile({ bundesland: 'niederoesterreich', gebaeudeklasse: 'GK 4', bauweise: ['holzbau'], nutzungen: ['wohnen', 'buero'] })
)

describe('similarityFacts', () => {
  it('reads the class from a number or any spelling with a digit, and treats anything else as unknown', () => {
    expect(similarityFacts(profile({ gebaeudeklasse: 4 })).gebaeudeklasse).toEqual([4])
    expect(similarityFacts(profile({ gebaeudeklasse: 'GK4' })).gebaeudeklasse).toEqual([4])
    expect(similarityFacts(profile({ gebaeudeklasse: 'unklar' })).gebaeudeklasse).toEqual([])
    expect(similarityFacts(profile({ bundesland: 42, nutzungen: 'Wohnen' }))).toMatchObject({
      bundesland: null,
      nutzungen: ['wohnen'],
    })
  })

  it('reads what the intake wizard stores: a building’s answers under its instance, every building', () => {
    // The producer, not a hand-written profile: the wizard keys a building's
    // answers `bauweise@bw1`, and a ranking that read only `bauweise` saw
    // nothing of a real project but its Bundesland and kind of work.
    const facts = similarityFacts(
      buildIntakeProfile(
        {
          A2_country: 'at',
          A2_land: 'niederoesterreich',
          A5: ['neubau'],
          'C1@bw1': 'gebaeude',
          'C10@bw1': ['holzbau'],
          'D0@bw1': ['wohnen'],
          'C1@bw2': 'gebaeude',
          'C10@bw2': ['mauerwerk_massivbau'],
          'D0@bw2': ['buero'],
        },
        projectIntakeDefinitionV1,
        {
          bauwerke: [
            { id: 'bw1', name: 'Haupthaus' },
            { id: 'bw2', name: 'Nebengebäude' },
          ],
        }
      )
    )

    expect(facts).toMatchObject({
      bundesland: 'niederoesterreich',
      bauweise: ['holzbau', 'mauerwerk_massivbau'],
      nutzungen: ['wohnen', 'buero'],
      vorhabensart: ['neubau'],
    })
  })

  it('reads a Land’s label and its token as one Land, and a site abroad as no Land', () => {
    const at = (bundesland: string) => similarityFacts(profile({ bundesland })).bundesland
    expect(at('Niederösterreich')).toBe('niederoesterreich')
    expect(at('niederoesterreich')).toBe('niederoesterreich')
    expect(at('ausserhalb_oesterreichs')).toBeNull()
    const abroad = similarityFacts(profile({ bundesland: 'ausserhalb_oesterreichs' }))
    expect(similarity(abroad, abroad)).toBe(0)
  })

  it('keeps a site abroad’s token for the wire, while the ranking still reads it as no Land', () => {
    const abroad = profile({ bundesland: 'ausserhalb_oesterreichs' })
    expect(bundeslandOf(abroad)).toBe('ausserhalb_oesterreichs')
    expect(bundeslandOf(profile({ bundesland: 'Niederösterreich' }))).toBe('niederoesterreich')
    expect(bundeslandOf(null)).toBeNull()
    const facts = similarityFacts(abroad)
    expect(facts.bundesland).toBeNull()
    expect(similarity(facts, similarityFacts(abroad))).toBe(0)
  })

  it('reads every building’s class, and a use zone’s copy of a fact as no building’s', () => {
    expect(similarityFacts(profile({ 'gebaeudeklasse@bw2': 'GK 2', 'gebaeudeklasse@bw1': 4 })).gebaeudeklasse).toEqual([2, 4])
    expect(similarityFacts(profile({ 'nutzungen@bw1@wohnen': ['garage'] })).nutzungen).toEqual([])
  })
})

describe('similarity', () => {
  it('matches a project of several buildings on its closest one', () => {
    const mixed = similarityFacts(profile({ 'gebaeudeklasse@bw1': 2, 'gebaeudeklasse@bw2': 4 }))
    expect(similarity(mixed, similarityFacts(profile({ gebaeudeklasse: 4 })))).toBe(SIMILARITY_WEIGHTS.gebaeudeklasse)
    expect(similarity(mixed, similarityFacts(profile({ gebaeudeklasse: 5 })))).toBe(SIMILARITY_WEIGHTS.gebaeudeklasseAdjacent)
  })

  it('weighs the same Bundesland above any single trait, and below class, construction and uses together', () => {
    const at = (facts: Record<string, unknown>) => similarity(here, similarityFacts(profile(facts)))
    const sameLand = at({ bundesland: 'niederoesterreich' })
    expect(sameLand).toBeGreaterThan(at({ gebaeudeklasse: 4 }))
    expect(sameLand).toBeGreaterThan(at({ bauweise: ['holzbau'] }))
    expect(at({ gebaeudeklasse: 4, bauweise: ['holzbau'], nutzungen: ['wohnen', 'buero'] })).toBeGreaterThan(sameLand)
  })

  it('reads the Bauweise as the multi-select it is: a hybrid shares its timber with a timber building', () => {
    const at = (bauweise: unknown) => similarity(here, similarityFacts(profile({ bauweise })))
    expect(at(['stahlbeton', 'holzbau'])).toBeGreaterThan(0)
    expect(at(['stahlbeton'])).toBe(0)
    // „noch offen" says nothing about the building, so two undecided projects share nothing.
    expect(similarity(similarityFacts(profile({ bauweise: ['offen'] })), similarityFacts(profile({ bauweise: ['offen'] })))).toBe(0)
  })

  it('reads the kind of work as the multi-select the intake stores, and an older single token alike', () => {
    const work = (vorhabensart: unknown) => similarityFacts(profile({ vorhabensart }))
    expect(similarity(work(['neubau', 'zubau']), work(['zubau']))).toBe(SIMILARITY_WEIGHTS.vorhabensart)
    expect(similarity(work(['neubau']), work('neubau'))).toBe(SIMILARITY_WEIGHTS.vorhabensart)
    expect(similarity(work(['umbau']), work(['neubau']))).toBe(0)
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
      profile({ bundesland: 'niederoesterreich', gebaeudeklasse: 4, bauweise: ['stahlbeton'], nutzungen: ['wohnen'] })
    )
    expect(sharedTraits(here, other)).toEqual([
      { key: 'bundesland', value: 'niederoesterreich' },
      { key: 'gebaeudeklasse', value: '4' },
      { key: 'nutzungen', value: 'wohnen' },
    ])
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
