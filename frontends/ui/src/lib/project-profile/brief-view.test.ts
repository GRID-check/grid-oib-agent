/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { buildProjectBriefView } from './brief-view'
import {
  normalizeProfilePatchOperations,
  pruneResolvedAssumptions,
  pruneResolvedUnknowns,
} from './patch-engine'
import type { ProjectProfile } from './types'

const NOW = '2026-07-08T00:00:00.000Z'

function fact(value: ProjectProfile['facts'][string]['value']): ProjectProfile['facts'][string] {
  return { value, confidence: 'confirmed', source: 'onboarding', updatedAt: NOW }
}

describe('buildProjectBriefView', () => {
  const profile: ProjectProfile = {
    facts: {
      project_name: fact('Wohnhaus Lerchenfelder'),
      bundesland: fact('wien'),
      vorhabensart: fact(['neubau']),
      // Scoped bauwerk facts + the structural building-name fact used to label them.
      'bauwerk_name@bw1': fact('Haupthaus'),
      'bauwerkstyp@bw1': fact('gebaeude'),
      'geschosse_oberirdisch@bw1': fact(5),
      custom_agent_fact: fact('brandschutzkonzept liegt vor'),
    },
    goals: {},
    unknowns: ['fluchtniveau_m@bw1', 'fluchtniveau_m@bw1', 'bundesland'],
    assumptions: {
      flaechenwidmung: {
        value: 'wohngebiet',
        status: 'unconfirmed',
        reason: 'Typical for the district per the uploaded plan.',
        source: 'agent_suggested',
        updatedAt: NOW,
      },
    },
  }

  it('groups facts by intake stage with question/option labels, in intake order', () => {
    const view = buildProjectBriefView(profile)
    expect(view.groups.map((g) => g.id)).toEqual(['A', 'C', 'other'])
    const a = view.groups.find((g) => g.id === 'A')!
    expect(a.facts).toEqual([
      expect.objectContaining({ key: 'bundesland', label: 'Bundesland', value: 'Wien' }),
      expect.objectContaining({
        key: 'vorhabensart',
        label: 'Art des Vorhabens (Projekt gesamt)',
        value: 'Neubau',
      }),
    ])
    const c = view.groups.find((g) => g.id === 'C')!
    // Scoped keys resolve to their base question label, suffixed with the building name.
    expect(c.facts).toEqual([
      expect.objectContaining({ key: 'bauwerkstyp@bw1', label: 'Bauwerkstyp · Haupthaus' }),
      expect.objectContaining({
        key: 'geschosse_oberirdisch@bw1',
        label: 'Anzahl oberirdischer Geschoße (Zielzustand) · Haupthaus',
        value: '5',
      }),
    ])
  })

  it('hides project_name and bauwerk_name structural keys, humanizes unknown keys', () => {
    const view = buildProjectBriefView(profile)
    const allKeys = view.groups.flatMap((g) => g.facts.map((f) => f.key))
    expect(allKeys).not.toContain('project_name')
    expect(allKeys).not.toContain('bauwerk_name@bw1')
    const other = view.groups.find((g) => g.id === 'other')!
    expect(other.facts).toEqual([
      expect.objectContaining({
        label: 'Custom agent fact',
        value: 'brandschutzkonzept liegt vor',
      }),
    ])
  })

  it('dedupes unknowns, drops answered ones, resolves scoped labels', () => {
    const view = buildProjectBriefView(profile)
    // `bundesland` is answered by a fact → dropped; the scoped escape-level unknown remains.
    expect(view.missing).toEqual([
      { key: 'fluchtniveau_m@bw1', label: 'Fluchtniveau (Zielzustand)' },
    ])
  })

  it('exposes assumptions with display and raw values', () => {
    const view = buildProjectBriefView(profile)
    expect(view.assumptions).toEqual([
      expect.objectContaining({
        key: 'flaechenwidmung',
        label: 'Flächenwidmung (Kategorie)',
        value: 'Wohngebiet',
        rawValue: 'wohngebiet',
        reason: 'Typical for the district per the uploaded plan.',
      }),
    ])
  })

  it('counts completeness as answered vs answered+missing', () => {
    const view = buildProjectBriefView(profile)
    // project_name + bauwerk_name@bw1 hidden → 5 visible facts.
    expect(view.answeredCount).toBe(5)
    expect(view.totalCount).toBe(6) // + the one remaining scoped unknown
  })

  it('tolerates malformed input by falling back to an empty profile', () => {
    const view = buildProjectBriefView({ facts: 'garbage' })
    expect(view.groups).toEqual([])
    expect(view.totalCount).toBe(0)
  })
})

describe('normalizeProfilePatchOperations', () => {
  it('wraps a bare fact value with user_confirmed provenance', () => {
    const [op] = normalizeProfilePatchOperations(
      [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK5' }],
      NOW
    )
    expect(op.value).toEqual({
      value: 'GK5',
      confidence: 'confirmed',
      source: 'user_confirmed',
      updatedAt: NOW,
    })
  })

  it('wraps a bare assumption value as unconfirmed agent_suggested', () => {
    const [op] = normalizeProfilePatchOperations(
      [{ op: 'add', path: '/assumptions/widmung', value: 'bauland' }],
      NOW
    )
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
      NOW
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
    const profile: ProjectProfile = {
      facts: {},
      goals: {},
      unknowns: ['fluchtniveau'],
      assumptions: {},
    }
    expect(pruneResolvedUnknowns(profile)).toBe(profile)
  })
})

describe('pruneResolvedAssumptions', () => {
  const assumption = (value: string): ProjectProfile['assumptions'][string] => ({
    value,
    status: 'unconfirmed',
    reason: 'Defaulted for projects created before the location question existed.',
    source: 'onboarding_default',
    updatedAt: NOW,
  })

  it('drops an assumption once a confirmed fact exists under the same key', () => {
    // The migration-backfilled bundesland=wien default must vanish when the
    // user answers the location question — never two jurisdictions at once.
    const profile: ProjectProfile = {
      facts: { bundesland: fact('tirol') },
      goals: {},
      unknowns: [],
      assumptions: { bundesland: assumption('wien'), widmung: assumption('bauland') },
    }

    const pruned = pruneResolvedAssumptions(profile)

    expect(pruned.assumptions).toEqual({ widmung: assumption('bauland') })
  })

  it('returns the same object when no assumption is superseded', () => {
    const profile: ProjectProfile = {
      facts: { hauptnutzung: fact('wohnen') },
      goals: {},
      unknowns: [],
      assumptions: { bundesland: assumption('wien') },
    }

    expect(pruneResolvedAssumptions(profile)).toBe(profile)
  })
})
