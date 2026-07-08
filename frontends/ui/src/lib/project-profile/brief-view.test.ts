import { describe, expect, it } from 'vitest'

import { buildProjectBriefView } from './brief-view'
import { normalizeProfilePatchOperations, pruneResolvedUnknowns } from './patch-engine'
import type { ProjectProfile } from './types'

const NOW = '2026-07-08T00:00:00.000Z'

function fact(value: ProjectProfile['facts'][string]['value']): ProjectProfile['facts'][string] {
  return { value, confidence: 'confirmed', source: 'onboarding', updatedAt: NOW }
}

describe('buildProjectBriefView', () => {
  const profile: ProjectProfile = {
    facts: {
      project_name: fact('Wohnhaus Lerchenfelder'),
      hauptnutzung: fact('wohnen'),
      gebaeudeklasse: fact('GK4'),
      geschosse_oberirdisch: fact(5),
      grundgrenze: fact(true),
      custom_agent_fact: fact('brandschutzkonzept liegt vor'),
    },
    goals: { focus_areas: ['einreichung', 'brandschutz'], goal_details: null },
    unknowns: ['fluchtniveau', 'fluchtniveau', 'gebaeudeklasse'],
    assumptions: {
      widmung: {
        value: 'bauland',
        status: 'unconfirmed',
        reason: 'Typical for the district per the uploaded plan.',
        source: 'agent_suggested',
        updatedAt: NOW,
      },
    },
  }

  it('groups facts by intake stage with question/option labels, in intake order', () => {
    const view = buildProjectBriefView(profile)
    expect(view.groups.map((g) => g.id)).toEqual(['core', 'classification', 'building', 'regulatory', 'other'])
    const core = view.groups.find((g) => g.id === 'core')!
    expect(core.facts).toEqual([
      expect.objectContaining({ key: 'hauptnutzung', label: 'Main use', value: 'Residential' }),
    ])
    const regulatory = view.groups.find((g) => g.id === 'regulatory')!
    expect(regulatory.facts).toEqual([
      expect.objectContaining({ key: 'grundgrenze', label: 'On a property boundary', value: 'Yes' }),
    ])
  })

  it('hides project_name (already in the page header) and humanizes unknown keys', () => {
    const view = buildProjectBriefView(profile)
    const allKeys = view.groups.flatMap((g) => g.facts.map((f) => f.key))
    expect(allKeys).not.toContain('project_name')
    const other = view.groups.find((g) => g.id === 'other')!
    expect(other.facts).toEqual([
      expect.objectContaining({ label: 'Custom agent fact', value: 'brandschutzkonzept liegt vor' }),
    ])
  })

  it('maps focus areas to their option labels', () => {
    const view = buildProjectBriefView(profile)
    expect(view.focusAreas).toEqual([
      'Getting a permit submission (Einreichung) approved',
      'Fire-safety concept',
    ])
  })

  it('dedupes unknowns and drops ones already answered by a fact', () => {
    const view = buildProjectBriefView(profile)
    expect(view.missing).toEqual([{ key: 'fluchtniveau', label: 'Escape level' }])
  })

  it('exposes assumptions with display and raw values', () => {
    const view = buildProjectBriefView(profile)
    expect(view.assumptions).toEqual([
      expect.objectContaining({
        key: 'widmung',
        label: 'Zoning',
        value: 'Building land (Bauland)',
        rawValue: 'bauland',
        reason: 'Typical for the district per the uploaded plan.',
      }),
    ])
  })

  it('counts completeness as answered vs answered+missing', () => {
    const view = buildProjectBriefView(profile)
    expect(view.answeredCount).toBe(5) // project_name hidden
    expect(view.totalCount).toBe(6) // + fluchtniveau
  })

  it('tolerates malformed input by falling back to an empty profile', () => {
    const view = buildProjectBriefView({ facts: 'garbage' })
    expect(view.groups).toEqual([])
    expect(view.totalCount).toBe(0)
  })
})

describe('normalizeProfilePatchOperations', () => {
  it('wraps a bare fact value with user_confirmed provenance', () => {
    const [op] = normalizeProfilePatchOperations([{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK5' }], NOW)
    expect(op.value).toEqual({ value: 'GK5', confidence: 'confirmed', source: 'user_confirmed', updatedAt: NOW })
  })

  it('wraps a bare assumption value as unconfirmed agent_suggested', () => {
    const [op] = normalizeProfilePatchOperations([{ op: 'add', path: '/assumptions/widmung', value: 'bauland' }], NOW)
    expect(op.value).toEqual({
      value: 'bauland',
      status: 'unconfirmed',
      reason: '',
      source: 'agent_suggested',
      updatedAt: NOW,
    })
  })

  it('leaves complete objects, removes, deep paths and other sections untouched', () => {
    const ops = normalizeProfilePatchOperations(
      [
        { op: 'add', path: '/facts/widmung', value: fact('bauland') },
        { op: 'remove', path: '/assumptions/widmung' },
        { op: 'replace', path: '/facts/widmung/value', value: 'freiland' },
        { op: 'add', path: '/unknowns/-', value: 'fluchtniveau' },
      ],
      NOW,
    )
    expect(ops[0].value).toEqual(fact('bauland'))
    expect(ops[1]).toEqual({ op: 'remove', path: '/assumptions/widmung' })
    expect(ops[2].value).toBe('freiland')
    expect(ops[3].value).toBe('fluchtniveau')
  })
})

describe('pruneResolvedUnknowns', () => {
  it('drops unknowns answered by a fact and dedupes, preserving open ones', () => {
    const profile: ProjectProfile = {
      facts: { gebaeudeklasse: fact('GK4') },
      goals: {},
      unknowns: ['gebaeudeklasse', 'fluchtniveau', 'fluchtniveau'],
      assumptions: {},
    }
    expect(pruneResolvedUnknowns(profile).unknowns).toEqual(['fluchtniveau'])
  })

  it('returns the same object when nothing changes', () => {
    const profile: ProjectProfile = { facts: {}, goals: {}, unknowns: ['fluchtniveau'], assumptions: {} }
    expect(pruneResolvedUnknowns(profile)).toBe(profile)
  })
})
