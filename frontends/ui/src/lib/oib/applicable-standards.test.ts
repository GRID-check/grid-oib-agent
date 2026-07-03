// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'

import { getApplicableStandards } from './applicable-standards'
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

  it('flags OIB 2.3 as required with the Hochhaus reason for a high-rise', () => {
    const result = getApplicableStandards(
      profileWith({ hauptnutzung: 'wohnen', gebaeudeklasse: 'GK5', fluchtniveau: '>22m' })
    )

    const oib23 = result.find((s) => s.code === 'OIB 2.3')
    expect(oib23).toBeDefined()
    expect(oib23?.status).toBe('required')
    expect(oib23?.reason).toContain('Hochhaus')
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
