/**
 * Derived project facts.
 *
 * `geschosse_oberirdisch` picks a Gebäudeklasse and a Gebäudeklasse decides what
 * the fire-safety answer is, so the interesting assertions are the refusals: the
 * suggestion that is NOT made when the model does not support it, and the
 * confidence that stays medium even when the arithmetic is exact.
 */

import { describe, expect, it } from 'vitest'
import { deriveProfileSuggestions, renderProfileSuggestions } from './profile'
import type { BimModelSummary, BimStorey } from './types'

function storey(name: string, elevation: number | null, elementCount = 20): BimStorey {
  return { globalId: `s-${name}`, expressId: 1, name, elevation, elementCount }
}

function summary(storeys: BimStorey[], spaces = 12): BimModelSummary {
  return {
    schema: 'IFC4',
    header: {
      name: null,
      timeStamp: null,
      author: [],
      organization: [],
      preprocessorVersion: null,
      originatingSystem: null,
      description: [],
    },
    units: { length: null, area: null, volume: null },
    projectName: null,
    siteName: null,
    buildingNames: [],
    storeys,
    spatial: null,
    typeCounts: {},
    propertySetNames: [],
    quantitySetNames: [],
    materialNames: [],
    totals: { entities: 0, elements: 200, spaces, storeys: storeys.length },
    quantityTotals: { netFloorAreaM2: null, grossFloorAreaM2: null, netVolumeM3: null },
    health: null,
    parseMs: 1,
    fileSizeBytes: 1,
    truncatedAt: null,
  }
}

const HOUSE = [
  storey('Kellergeschoss', -2.85),
  storey('Erdgeschoss', 0),
  storey('1. Obergeschoss', 3),
  storey('2. Obergeschoss', 6),
]

function suggestion(input: ReturnType<typeof deriveProfileSuggestions>, key: string) {
  return input.find((entry) => entry.key === key)
}

describe('deriveProfileSuggestions', () => {
  it('counts a storey at exactly 0 as above ground', () => {
    const derived = deriveProfileSuggestions({ summary: summary(HOUSE), spaceNames: [] })
    expect(suggestion(derived, 'geschosse_oberirdisch')?.value).toBe(3)
    expect(suggestion(derived, 'geschosse_unterirdisch')?.value).toBe(1)
  })

  it('drops to medium confidence when some storeys have no elevation', () => {
    const derived = deriveProfileSuggestions({
      summary: summary([...HOUSE, storey('Dachgeschoss', null)]),
      spaceNames: [],
    })
    expect(suggestion(derived, 'geschosse_oberirdisch')?.confidence).toBe('medium')
  })

  it('omits the storey counts entirely when nothing is placed', () => {
    const derived = deriveProfileSuggestions({
      summary: summary([storey('Erdgeschoss', null)]),
      spaceNames: [],
    })
    expect(suggestion(derived, 'geschosse_oberirdisch')).toBeUndefined()
    expect(suggestion(derived, 'fluchtniveau')).toBeUndefined()
  })

  it('bands the Fluchtniveau from the highest OCCUPIED storey', () => {
    // A model with an empty roof-plane storey at 12 m would otherwise jump a
    // band and, with it, a Gebäudeklasse.
    const derived = deriveProfileSuggestions({
      summary: summary([...HOUSE, storey('Dachebene', 12, 0)]),
      spaceNames: [],
    })
    expect(suggestion(derived, 'fluchtniveau')?.value).toBe('<=7m')
  })

  it('picks the next band up for a taller building', () => {
    const derived = deriveProfileSuggestions({
      summary: summary([storey('EG', 0), storey('OG8', 9)]),
      spaceNames: [],
    })
    expect(suggestion(derived, 'fluchtniveau')?.value).toBe('7-11m')
  })

  it('never claims better than medium confidence on the Fluchtniveau', () => {
    // The regulation means the floor level of the topmost storey with an escape
    // route. A storey elevation is a proxy for that, and the difference decides
    // a Gebäudeklasse — so this stays a proposal however exact the number is.
    const derived = deriveProfileSuggestions({ summary: summary(HOUSE), spaceNames: [] })
    expect(suggestion(derived, 'fluchtniveau')?.confidence).toBe('medium')
  })

  it('reads the main use from the room names', () => {
    const derived = deriveProfileSuggestions({
      summary: summary(HOUSE),
      spaceNames: ['WE 01 Wohnzimmer', 'WE 01 Schlafzimmer', 'WE 02 Küche', 'Flur', 'Technik'],
    })
    expect(suggestion(derived, 'hauptnutzung')?.value).toBe('wohnen')
  })

  it('ignores circulation and service rooms', () => {
    const derived = deriveProfileSuggestions({
      summary: summary(HOUSE),
      spaceNames: ['Kellerabteil Lager', 'Technikraum Lager', 'Garage Lager'],
    })
    expect(suggestion(derived, 'hauptnutzung')).toBeUndefined()
  })

  it('says nothing when one room matches, because one room is a coincidence', () => {
    const derived = deriveProfileSuggestions({
      summary: summary(HOUSE),
      spaceNames: ['Büro', 'Raum 1', 'Raum 2', 'Raum 3'],
    })
    expect(suggestion(derived, 'hauptnutzung')).toBeUndefined()
  })

  it('says nothing for a tie, rather than guessing a mixed-use building', () => {
    const derived = deriveProfileSuggestions({
      summary: summary(HOUSE),
      spaceNames: ['Wohnzimmer', 'Schlafzimmer', 'Büro 1', 'Büro 2'],
    })
    expect(suggestion(derived, 'hauptnutzung')).toBeUndefined()
  })

  it('offers the room count as the room count, at the lowest confidence', () => {
    // Rooms are not Nutzungseinheiten — a flat is several rooms — and the
    // evidence line has to say so.
    const derived = deriveProfileSuggestions({ summary: summary(HOUSE, 12), spaceNames: [] })
    const units = suggestion(derived, 'anzahl_einheiten')
    expect(units?.value).toBe(12)
    expect(units?.confidence).toBe('low')
    expect(units?.evidence).toContain('nicht dasselbe')
  })

  it('carries evidence on every suggestion', () => {
    const derived = deriveProfileSuggestions({
      summary: summary(HOUSE),
      spaceNames: ['Wohnzimmer', 'Schlafzimmer'],
    })
    expect(derived.length).toBeGreaterThan(0)
    for (const entry of derived) {
      expect(entry.evidence.length).toBeGreaterThan(0)
    }
  })
})

describe('renderProfileSuggestions', () => {
  it('says so plainly when the model supports nothing', () => {
    expect(renderProfileSuggestions([])).toContain('keine Projektangaben')
  })

  it('puts the value, the confidence and the evidence on one line each', () => {
    const rendered = renderProfileSuggestions(
      deriveProfileSuggestions({ summary: summary(HOUSE), spaceNames: [] })
    )
    expect(rendered.split('\n')[0]).toMatch(/^geschosse_oberirdisch = 3 \(high\) — /)
  })
})
