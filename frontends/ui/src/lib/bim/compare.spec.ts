/**
 * Revision comparison.
 *
 * The claim under test is that GlobalId is a stable identity across exports and
 * express id is not — so a re-export that renumbers everything must report zero
 * changes, and a wall that lost its fire rating must report one.
 */

import { describe, expect, it } from 'vitest'
import { compareModels, renderComparison } from './compare'
import type { BimElement } from './types'

function element(overrides: Partial<BimElement> = {}): BimElement {
  return {
    globalId: '0GridFixture00Wall0001',
    expressId: 21,
    ifcType: 'IfcWall',
    name: 'Aussenwand Nord',
    description: null,
    predefinedType: 'SOLIDWALL',
    objectType: null,
    tag: 'W-01',
    typeName: 'AW 38',
    containerKind: 'storey',
    containerGlobalId: 'g-eg',
    containerName: 'Erdgeschoss',
    storeyGlobalId: 'g-eg',
    storeyName: 'Erdgeschoss',
    materials: ['Stahlbeton'],
    classifications: [],
    properties: { Pset_WallCommon: { FireRating: 'REI 90', IsExternal: true } },
    quantities: { Qto_WallBaseQuantities: { NetSideArea: 24.5 } },
    ...overrides,
  }
}

describe('compareModels', () => {
  it('reports nothing for a re-export that only renumbered the express ids', () => {
    // The whole premise: express ids are re-assigned on every export, so
    // comparing them would report every element in the building as changed.
    const base = [element({ expressId: 21 }), element({ expressId: 22, globalId: '0GridFixture00Wall0002' })]
    const revision = [
      element({ expressId: 900 }),
      element({ expressId: 901, globalId: '0GridFixture00Wall0002' }),
    ]
    const result = compareModels({ base, revision })
    expect(result).toMatchObject({ added: [], removed: [], changed: [], unchangedCount: 2 })
    expect(renderComparison(result)).toContain('Keine Unterschiede')
  })

  it('separates added from removed by GlobalId', () => {
    const result = compareModels({
      base: [element(), element({ globalId: '0GridFixture00Wall0002', name: 'Entfernt' })],
      revision: [element(), element({ globalId: '0GridFixture00Wall0003', name: 'Neu' })],
    })
    expect(result.added.map((entry) => entry.name)).toEqual(['Neu'])
    expect(result.removed.map((entry) => entry.name)).toEqual(['Entfernt'])
    expect(result.unchangedCount).toBe(1)
  })

  it('reports a changed property value with both sides', () => {
    const result = compareModels({
      base: [element()],
      revision: [element({ properties: { Pset_WallCommon: { FireRating: 'REI 30', IsExternal: true } } })],
    })
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0].changes).toEqual([
      { field: 'Pset_WallCommon.FireRating', before: 'REI 90', after: 'REI 30', delta: null },
    ])
  })

  it('reports a property that DISAPPEARED, not only one that moved', () => {
    // A wall that lost its fire rating is the finding an approval hangs on;
    // comparing only surviving keys would hide it completely.
    const result = compareModels({
      base: [element()],
      revision: [element({ properties: { Pset_WallCommon: { IsExternal: true } } })],
    })
    expect(result.changed[0].changes).toEqual([
      { field: 'Pset_WallCommon.FireRating', before: 'REI 90', after: null, delta: null },
    ])
  })

  it('carries a signed delta for numeric changes', () => {
    const result = compareModels({
      base: [element()],
      revision: [element({ quantities: { Qto_WallBaseQuantities: { NetSideArea: 26 } } })],
    })
    expect(result.changed[0].changes[0]).toEqual({
      field: 'Qto_WallBaseQuantities.NetSideArea',
      before: 24.5,
      after: 26,
      delta: 1.5,
    })
  })

  it('reports a move between storeys', () => {
    const result = compareModels({
      base: [element()],
      revision: [element({ storeyName: 'Obergeschoss', storeyGlobalId: 'g-og' })],
    })
    expect(result.changed[0].changes).toEqual([
      { field: 'storey', before: 'Erdgeschoss', after: 'Obergeschoss', delta: null },
    ])
  })

  it('reports a changed material build-up', () => {
    const result = compareModels({
      base: [element()],
      revision: [element({ materials: ['Stahlbeton', 'Waermedaemmung EPS'] })],
    })
    expect(result.changed[0].changes[0]).toMatchObject({
      field: 'materials',
      before: 'Stahlbeton',
      after: 'Stahlbeton, Waermedaemmung EPS',
    })
  })

  it('puts the most-changed element first', () => {
    const heavilyChanged = element({
      globalId: '0GridFixture00Wall0002',
      name: 'Andere Wand',
      storeyName: 'Obergeschoss',
      properties: { Pset_WallCommon: { FireRating: 'EI 30', IsExternal: false } },
    })
    const result = compareModels({
      base: [element(), element({ globalId: '0GridFixture00Wall0002', name: 'Andere Wand' })],
      revision: [element({ name: 'Aussenwand Nord (neu)' }), heavilyChanged],
    })
    // Three differences beats one; a reader scanning the list should meet the
    // element that actually moved first.
    expect(result.changed[0].globalId).toBe('0GridFixture00Wall0002')
    expect(result.changed[0].changes.length).toBeGreaterThan(result.changed[1].changes.length)
  })

  it('says out loud when either side was capped', () => {
    const result = compareModels({ base: [element()], revision: [element()], truncated: true })
    // A missing element may be a cap rather than a deletion, and presenting a
    // truncated diff as complete would be the worst possible failure here.
    expect(result.truncated).toBe(true)
    expect(renderComparison(result)).toContain('gekürzt indiziert')
  })

  it('renders the four buckets in one line', () => {
    const result = compareModels({
      base: [element(), element({ globalId: '0GridFixture00Wall0002' })],
      revision: [element({ name: 'Neu benannt' }), element({ globalId: '0GridFixture00Wall0003' })],
    })
    expect(renderComparison(result)).toBe('Vergleich: 1 neu, 1 entfallen, 1 geändert, 0 unverändert.')
  })
})
