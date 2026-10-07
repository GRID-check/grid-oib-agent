/**
 * The fingerprint the closing debrief asks for is the one the reference ranking
 * reads: every fact in the similarity's order, labelled as the intake wizard
 * labels it, and an open fact stays visibly open rather than disappearing.
 */

import { describe, expect, it } from 'vitest'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { FINGERPRINT_KEYS, factLabel, fingerprintLabels, fingerprintOf } from './fingerprint'

function profile(facts: Record<string, unknown>): ProjectProfile {
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

describe('fingerprintOf', () => {
  it('names every fact the ranking weighs, in its order, with the wizard’s labels', () => {
    const facts = fingerprintOf(
      profile({
        bundesland: 'niederoesterreich',
        gebaeudeklasse: 'GK 4',
        bauweise: ['holzbau', 'stahlbeton'],
        nutzungen: ['wohnen'],
        vorhabensart: ['neubau', 'zubau'],
      })
    )

    expect(facts.map((fact) => fact.key)).toEqual([...FINGERPRINT_KEYS])
    expect(facts.find((fact) => fact.key === 'bundesland')?.value).toBe('Niederösterreich')
    expect(facts.find((fact) => fact.key === 'gebaeudeklasse')?.value).toBe('GK 4')
    expect(facts.find((fact) => fact.key === 'bauweise')?.value).toBe('Holzbau/Stahlbeton')
    expect(facts.find((fact) => fact.key === 'vorhabensart')?.value).toBe('Neubau/Zubau')
  })

  it('keeps an open fact as null, „noch offen" included, so the debrief can ask for it', () => {
    const facts = fingerprintOf(profile({ bundesland: 'wien', bauweise: ['offen'] }))

    expect(facts).toHaveLength(FINGERPRINT_KEYS.length)
    expect(facts.filter((fact) => fact.value === null).map((fact) => fact.key)).toEqual([
      'gebaeudeklasse',
      'bauweise',
      'nutzungen',
      'vorhabensart',
    ])
  })

  it('reads a project without a profile as entirely open', () => {
    expect(fingerprintOf(null).every((fact) => fact.value === null)).toBe(true)
    expect(fingerprintLabels(null)).toEqual([])
  })
})

describe('factLabel', () => {
  it('shows a token no option names as it is', () => {
    expect(factLabel('bundesland', 'atlantis')).toBe('atlantis')
  })
})
