import { describe, expect, it } from 'vitest'

import {
  evaluateCondition,
  getApplicableStandards,
  resolveApplicability,
} from './applicable-standards'
import parityFixtures from './applicability-parity.generated.json'
import type { ProjectProfile, ProjectPrimitiveValue } from '@/lib/project-profile/types'

/** Build a minimal, schema-shaped ProjectProfile from a flat map of fact values. */
function profileWith(facts: Record<string, ProjectPrimitiveValue>): ProjectProfile {
  const now = '2026-07-03T00:00:00.000Z'
  return {
    facts: Object.fromEntries(
      Object.entries(facts).map(([id, value]) => [
        id,
        { value, confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: now },
      ])
    ),
    goals: {},
    unknowns: [],
    assumptions: {},
  }
}

const codesOf = (standards: ReturnType<typeof getApplicableStandards>): string[] =>
  standards.map((s) => s.code)

describe('getApplicableStandards', () => {
  it('returns the six near-universal standards, all required, for a null profile', () => {
    const result = getApplicableStandards(null)

    expect(codesOf(result)).toEqual(['OIB 1', 'OIB 2', 'OIB 3', 'OIB 4', 'OIB 5', 'OIB 6'])
    expect(result).toHaveLength(6)
    expect(result.every((s) => s.status === 'required')).toBe(true)
  })

  it('returns the six required standards for an empty profile (no facts)', () => {
    const result = getApplicableStandards(profileWith({}))

    expect(codesOf(result)).toEqual(['OIB 1', 'OIB 2', 'OIB 3', 'OIB 4', 'OIB 5', 'OIB 6'])
    expect(result.every((s) => s.status === 'required')).toBe(true)
  })

  it('omits fire sub-standards for a residential GK2 low-rise and marks OIB 5 required', () => {
    const result = getApplicableStandards(
      profileWith({ hauptnutzung: 'wohnen', gebaeudeklasse: 'GK2', fluchtniveau: '<=7m' })
    )

    const codes = codesOf(result)
    expect(codes).not.toContain('OIB 2.1')
    expect(codes).not.toContain('OIB 2.2')
    expect(codes).not.toContain('OIB 2.3')

    const oib5 = result.find((s) => s.code === 'OIB 5')
    expect(oib5?.status).toBe('required')
  })

  it('flags OIB 2.3 as required for a high-rise', () => {
    const result = getApplicableStandards(
      profileWith({ hauptnutzung: 'wohnen', gebaeudeklasse: 'GK5', fluchtniveau: '>22m' })
    )

    const oib23 = result.find((s) => s.code === 'OIB 2.3')
    expect(oib23).toBeDefined()
    expect(oib23?.status).toBe('required')
  })

  it('handles a storage building with a basement: 2.1 required, 2.2 check, 6 check', () => {
    const result = getApplicableStandards(
      profileWith({ hauptnutzung: 'lager', geschosse_unterirdisch: 2 })
    )

    const byCode = Object.fromEntries(result.map((s) => [s.code, s]))
    expect(byCode['OIB 2.1']?.status).toBe('required')
    expect(byCode['OIB 2.2']?.status).toBe('check')
    expect(byCode['OIB 6']?.status).toBe('check')
  })
})

describe('evaluateCondition', () => {
  it('compares numbers numerically even when the fact is a string', () => {
    expect(evaluateCondition({ fact: 'geschosse_unterirdisch', op: 'gte', value: 1 }, { geschosse_unterirdisch: '2' })).toBe(true)
    expect(evaluateCondition({ fact: 'geschosse_unterirdisch', op: 'gte', value: 3 }, { geschosse_unterirdisch: '2' })).toBe(false)
  })

  it('treats missing and empty-string facts as absent', () => {
    expect(evaluateCondition({ fact: 'x', op: 'undefined' }, {})).toBe(true)
    expect(evaluateCondition({ fact: 'x', op: 'undefined' }, { x: '' })).toBe(true)
    expect(evaluateCondition({ fact: 'x', op: 'defined' }, { x: '0' })).toBe(true)
  })

  it('matches in against any option', () => {
    expect(evaluateCondition({ fact: 'hauptnutzung', op: 'in', value: ['lager', 'produzierend'] }, { hauptnutzung: 'lager' })).toBe(true)
    expect(evaluateCondition({ fact: 'hauptnutzung', op: 'in', value: ['lager', 'produzierend'] }, { hauptnutzung: 'wohnen' })).toBe(false)
  })

  it('eq treats booleans and their string renderings as equal', () => {
    expect(evaluateCondition({ fact: 'kleingartengebiet', op: 'eq', value: true }, { kleingartengebiet: true })).toBe(true)
    expect(evaluateCondition({ fact: 'kleingartengebiet', op: 'eq', value: true }, { kleingartengebiet: 'true' })).toBe(true)
    expect(evaluateCondition({ fact: 'kleingartengebiet', op: 'eq', value: true }, { kleingartengebiet: false })).toBe(false)
    expect(evaluateCondition({ fact: 'kleingartengebiet', op: 'eq', value: true }, {})).toBe(false)
  })
})

describe('registry parity (generated fixtures)', () => {
  // The fixtures are produced by scripts/build_applicability_rules.py from the
  // norm registry using the Python resolver — this suite is the cross-language
  // parity proof (spec §8 Phase 4 exit criterion).
  for (const fixture of parityFixtures) {
    it(`matches the Python resolver for profile '${fixture.name}'`, () => {
      const verdicts = resolveApplicability(fixture.facts)
      const actual = Object.fromEntries(
        [...verdicts.entries()].map(([normId, verdict]) => [
          normId,
          { status: verdict.status, reason: verdict.reason },
        ])
      )
      const expected = Object.fromEntries(
        Object.entries(fixture.expected).map(([normId, e]) => [
          normId,
          { status: e.verdict, reason: e.reasonEn },
        ])
      )
      expect(actual).toEqual(expected)
    })
  }
})
