import { describe, expect, it } from 'vitest'

import { bindProjectFact, buildingClassNumber, projectFactResolver } from './answer-bindings'
import type { ProjectProfile } from './types'

const at = '2026-09-20T08:00:00Z'

const profile: ProjectProfile = {
  facts: {
    bundesland: { value: 'niederoesterreich', confidence: 'confirmed', source: 'onboarding', updatedAt: at },
    'fluchtniveau_m@bw1': { value: 10.8, confidence: 'confirmed', source: 'onboarding', updatedAt: at },
    bgf_oberirdisch: { value: 1450, confidence: 'confirmed', source: 'onboarding', updatedAt: at },
    nutzungen: { value: ['wohnen', 'buero'], confidence: 'confirmed', source: 'onboarding', updatedAt: at },
  },
  goals: {},
  unknowns: ['gebaeudeklasse'],
  assumptions: {
    geschosse_oberirdisch: { value: 5, status: 'unconfirmed', reason: 'geschätzt', source: 'agent_suggested', updatedAt: at },
  },
}

describe('bindProjectFact', () => {
  it('prints a confirmed fact the way a planner writes it', () => {
    expect(bindProjectFact(profile, 'state')).toMatchObject({ state: 'confirmed', text: 'Niederösterreich' })
    expect(bindProjectFact(profile, 'gross_floor_area_m2')).toMatchObject({ text: '1.450 m²', number: 1450 })
    expect(bindProjectFact(profile, 'use').text).toBe('Wohnen, Büro / Verwaltung')
  })

  it('reads a fact recorded per Bauwerk', () => {
    expect(bindProjectFact(profile, 'escape_level_m')).toMatchObject({ state: 'confirmed', text: '10,8 m', number: 10.8 })
  })

  it('marks an assumption with its reason and a missing fact as missing', () => {
    expect(bindProjectFact(profile, 'storeys')).toMatchObject({ state: 'assumed', text: '5', reason: 'geschätzt' })
    expect(bindProjectFact(profile, 'building_class')).toEqual({ key: 'building_class', state: 'missing', text: null, number: null })
    expect(bindProjectFact(null, 'state').state).toBe('missing')
  })

  it('prints a Gebäudeklasse as „GK 4" whichever way it is stored', () => {
    expect(['GK4', 'GK 4', 4, '4'].map(buildingClassNumber)).toEqual([4, 4, 4, 4])
    const resolve = projectFactResolver({ facts: { gebaeudeklasse: { value: 'GK4', confidence: 'confirmed', source: 'onboarding', updatedAt: at } } })
    expect(resolve('building_class')).toMatchObject({ text: 'GK 4', number: 4 })
  })

  it('binds nothing from a profile that does not parse', () => {
    expect(projectFactResolver('not a profile')('state').state).toBe('missing')
  })
})
