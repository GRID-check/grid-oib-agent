/**
 * The fingerprint the closing debrief asks for is the one the reference ranking
 * reads, in the shape the intake wizard really stores: a building's answers
 * under its instance (`bauweise@bw1`), several buildings read as all of them.
 * Each case builds its profile with `buildIntakeProfile`, the producer, so a
 * hand-written profile in a shape production never stores cannot pass here.
 * Whether a fact applies, and whether the wizard can write it, is read off the
 * intake definition.
 */

import { describe, expect, it } from 'vitest'
import { buildIntakeProfile, projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import { FINGERPRINT_KEYS, factLabel, fingerprintLabels, fingerprintOf, type FingerprintFact } from './fingerprint'

type Answers = Record<string, ProjectPrimitiveValue>

const built = (answers: Answers, bauwerke = [{ id: 'bw1', name: 'Bauwerk 1' }]) =>
  buildIntakeProfile(answers, projectIntakeDefinitionV1, { bauwerke })

const byKey = (facts: FingerprintFact[]) => Object.fromEntries(facts.map((fact) => [fact.key, fact]))

describe('fingerprintOf', () => {
  it('reads what the wizard wrote, per building, with the wizard’s labels', () => {
    const facts = byKey(
      fingerprintOf(
        built({
          A2_country: 'at',
          A2_land: 'niederoesterreich',
          A5: ['neubau', 'zubau'],
          'C1@bw1': 'gebaeude',
          'C10@bw1': ['holzbau', 'stahlbeton'],
          'D0@bw1': ['wohnen'],
        })
      )
    )

    expect(Object.keys(facts)).toEqual([...FINGERPRINT_KEYS])
    expect(facts.bundesland.value).toBe('Niederösterreich')
    expect(facts.bauweise.value).toBe('Holzbau/Stahlbeton')
    expect(facts.nutzungen.value).not.toBeNull()
    expect(facts.vorhabensart.value).toBe('Neubau/Zubau')
  })

  it('reads a project of two buildings as both', () => {
    const facts = byKey(
      fingerprintOf(
        built(
          {
            A2_land: 'wien',
            'C1@bw1': 'gebaeude',
            'C10@bw1': ['holzbau'],
            'C1@bw2': 'gebaeude',
            'C10@bw2': ['mauerwerk_massivbau'],
          },
          [
            { id: 'bw1', name: 'Haupthaus' },
            { id: 'bw2', name: 'Nebengebäude' },
          ]
        )
      )
    )

    expect(facts.bauweise.value).toBe('Holzbau/Mauerwerk / Massivbau')
  })

  it('says the Bauweise does not apply to a structure that is no building, rather than calling it missing', () => {
    const facts = byKey(fingerprintOf(built({ A2_land: 'tirol', 'C1@bw1': 'sonstig' })))

    expect(facts.bauweise).toMatchObject({ value: null, applies: false })
    expect(facts.gebaeudeklasse.applies).toBe(false)
    expect(facts.vorhabensart.applies).toBe(true)
  })

  it('keeps a fact open, not inapplicable, while the answer it hangs on is still missing', () => {
    const facts = byKey(fingerprintOf(built({ A2_land: 'wien' })))

    expect(facts.bauweise).toMatchObject({ value: null, applies: true, editable: true })
  })

  it('knows the wizard derives the Gebäudeklasse, so the briefing cannot fill it', () => {
    const facts = byKey(fingerprintOf(built({ A2_land: 'wien', 'C1@bw1': 'gebaeude' })))

    expect(facts.gebaeudeklasse).toMatchObject({ value: null, applies: true, editable: false })
    expect(facts.bauweise.editable).toBe(true)
  })

  it('reads a class set on the project, as an accepted proposal writes it', () => {
    const profile = built({ A2_land: 'wien', 'C1@bw1': 'gebaeude' })
    profile.facts.gebaeudeklasse = { value: 'GK4', confidence: 'confirmed', source: 'user_confirmed', updatedAt: '' }

    expect(byKey(fingerprintOf(profile)).gebaeudeklasse.value).toBe('GK 4')
  })

  it('reads „noch offen" as open, and a project without a profile as entirely open', () => {
    expect(byKey(fingerprintOf(built({ 'C1@bw1': 'gebaeude', 'C10@bw1': ['offen'] }))).bauweise.value).toBeNull()
    expect(fingerprintOf(null).every((fact) => fact.value === null && fact.applies)).toBe(true)
    expect(fingerprintLabels(null)).toEqual([])
  })
})

describe('a value only the documents suggest', () => {
  const withSuggestion = () => {
    const profile = built({ A2_country: 'at', A2_land: 'niederoesterreich' })
    profile.assumptions.gebaeudeklasse = {
      value: 4,
      status: 'unconfirmed',
      reason: 'Baubeschreibung.pdf, S. 2: „Gebäudeklasse 4"',
      source: 'agent_suggested',
      updatedAt: '2026-10-08T00:00:00.000Z',
    }
    return profile
  }

  it('is flagged as suggested, and a confirmed value is not', () => {
    const facts = byKey(fingerprintOf(withSuggestion()))
    expect(facts.gebaeudeklasse).toMatchObject({ value: 'GK 4', suggested: true })
    expect(facts.bundesland).toMatchObject({ value: 'Niederösterreich', suggested: false })
  })

  it('is marked in the one-line summary the agent’s catalog prints', () => {
    expect(fingerprintLabels(withSuggestion())).toEqual(['Niederösterreich', 'GK 4 (aus den Unterlagen, unbestätigt)'])
  })
})

describe('factLabel', () => {
  it('shows a token no option names as it is', () => {
    expect(factLabel('bundesland', 'atlantis')).toBe('atlantis')
  })
})
