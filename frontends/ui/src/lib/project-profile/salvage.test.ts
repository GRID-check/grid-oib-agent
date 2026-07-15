import { describe, expect, it } from 'vitest'

import { salvageProjectProfile } from './salvage'
import type { ProjectFact } from './types'

/** A well-formed confirmed fact for a given value. */
function fact(value: ProjectFact['value']): ProjectFact {
  return { value, confidence: 'confirmed', source: 'onboarding', updatedAt: '2026-01-01T00:00:00.000Z' }
}

describe('salvageProjectProfile', () => {
  it('returns a fully valid profile unchanged with nothing dropped', () => {
    const raw = {
      facts: { hauptnutzung: fact('wohnen'), geschosse_oberirdisch: fact(3) },
      goals: { focus_areas: ['einreichung'] },
      unknowns: ['widmung'],
      assumptions: {},
    }
    const { profile, dropped } = salvageProjectProfile(raw)
    expect(dropped).toEqual([])
    expect(profile).not.toBeNull()
    expect(profile!.facts.hauptnutzung.value).toBe('wohnen')
    expect(profile!.goals.focus_areas).toEqual(['einreichung'])
    expect(profile!.unknowns).toEqual(['widmung'])
  })

  it('treats the empty {} default as absent — no salvage, no banner', () => {
    const { profile, dropped } = salvageProjectProfile({})
    expect(dropped).toEqual([])
    // An empty profile has no facts/goals/unknowns → the page treats it as create mode.
    expect(profile).not.toBeNull()
    expect(Object.keys(profile!.facts)).toHaveLength(0)
  })

  it('treats a genuinely absent profile (null/undefined) as create mode, no banner', () => {
    expect(salvageProjectProfile(null)).toEqual({ profile: null, dropped: [] })
    expect(salvageProjectProfile(undefined)).toEqual({ profile: null, dropped: [] })
  })

  it('salvages the valid facts and drops only the invalid ones (partial → banner)', () => {
    const raw = {
      facts: {
        hauptnutzung: fact('wohnen'), // valid
        broken: { value: 'x', confidence: 'guessed' }, // invalid confidence + missing fields
        geschosse_oberirdisch: fact(3), // valid
      },
      goals: {},
      unknowns: [],
      assumptions: {},
    }
    const { profile, dropped } = salvageProjectProfile(raw)
    expect(profile).not.toBeNull()
    expect(profile!.facts.hauptnutzung.value).toBe('wohnen')
    expect(profile!.facts.geschosse_oberirdisch.value).toBe(3)
    // The invalid fact is gone...
    expect(profile!.facts.broken).toBeUndefined()
    // ...and reported so the wizard can warn.
    expect(dropped).toContain('facts.broken')
  })

  it('salvages valid goals and unknowns while dropping malformed entries', () => {
    const raw = {
      facts: {},
      goals: { focus_areas: ['einreichung'], bad: { not: 'a primitive' } },
      unknowns: ['widmung', 42, 'bauweise'],
      assumptions: {},
    }
    const { profile, dropped } = salvageProjectProfile(raw)
    expect(profile).not.toBeNull()
    expect(profile!.goals.focus_areas).toEqual(['einreichung'])
    expect(profile!.goals.bad).toBeUndefined()
    expect(profile!.unknowns).toEqual(['widmung', 'bauweise'])
    expect(dropped).toContain('goals.bad')
    expect(dropped).toContain('unknowns[1]')
  })

  it('drops a whole section whose container is the wrong type', () => {
    const raw = { facts: 'not an object', goals: {}, unknowns: [], assumptions: {} }
    const { profile, dropped } = salvageProjectProfile(raw)
    // facts is unsalvageable, but a valid (empty) profile shell still results — and
    // since nothing was salvaged, the page opens in create mode.
    expect(profile).toBeNull()
    expect(dropped).toContain('facts')
  })

  it('reports a full failure (profile null + banner) for a non-object profile', () => {
    const { profile, dropped } = salvageProjectProfile('totally corrupt')
    expect(profile).toBeNull()
    expect(dropped.length).toBeGreaterThan(0)
  })

  it('reports a full failure when every entry is invalid', () => {
    const raw = {
      facts: { a: { bogus: true }, b: 12 },
      goals: { c: { nested: 'object' } },
      unknowns: [{ not: 'a string' }],
      assumptions: {},
    }
    const { profile, dropped } = salvageProjectProfile(raw)
    expect(profile).toBeNull()
    expect(dropped.length).toBeGreaterThan(0)
    expect(dropped).toContain('facts.a')
  })
})
