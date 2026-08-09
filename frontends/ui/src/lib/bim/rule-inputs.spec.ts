/**
 * The precomputed rule inputs.
 *
 * One property matters more than all the others: **the catalogue must produce
 * the same verdicts from the projection as from the full elements.** If it
 * does not, the fast path and the slow path answer differently for the same
 * building — the first reader of a model gets one Prüfbuch and the second gets
 * another, and nothing in the UI would show which. Everything else here is
 * detail.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RULE_INPUT_FIELDS,
  RULE_INPUT_KEYS,
  buildStoredRuleInputs,
  projectRuleInputs,
  readStoredRuleInputs,
} from './rule-inputs'
import { runBimRules } from './rules'
import type { BimElement } from './types'

function element(overrides: Partial<BimElement> & Pick<BimElement, 'ifcType'>): BimElement {
  return {
    globalId: '2O2Fr$t4X7Zf8NOew3FLKU',
    expressId: 4211,
    name: 'Aussenwand Nord',
    description: 'ignoriert',
    predefinedType: 'SOLIDWALL',
    objectType: 'Basic Wall',
    tag: 'W-01',
    typeName: 'AW 38',
    storeyGlobalId: '0GridGeoStEG000000001',
    storeyName: 'Erdgeschoss',
    containerGlobalId: null,
    containerKind: 'storey',
    containerName: 'Erdgeschoss',
    materials: ['Stahlbeton'],
    classifications: [{ system: 'ÖNORM', identification: 'B.2.1', name: 'Außenwände' }],
    properties: {},
    quantities: {},
    ...overrides,
  }
}

const STOREYS = [
  { name: 'Keller', elevation: -2.8 },
  { name: 'Erdgeschoss', elevation: 0 },
  { name: 'Obergeschoss', elevation: 3 },
]

/** A model exercising every rule, with the vendor noise a real export carries. */
const MODEL: BimElement[] = [
  element({
    ifcType: 'IfcWall',
    properties: {
      Pset_WallCommon: {
        LoadBearing: true,
        FireRating: 'R 60',
        IsExternal: true,
        ThermalTransmittance: 0.21,
        AcousticRating: 53,
        Combustible: false,
        Reference: 'AW 38',
      },
      'Revit Type Parameters': { 'Type Mark': 'AW38', Cost: 0, Keynote: '' },
    },
    quantities: { Qto_WallBaseQuantities: { Length: 8.4, NetSideArea: 21.4, Width: 0.38 } },
  }),
  element({
    ifcType: 'IfcDoor',
    globalId: '1kTvXnbbzCWw8lcMd1dR4o',
    name: 'T-14',
    quantities: { Qto_DoorBaseQuantities: { Width: 0.7, Height: 2.1 } },
  }),
  element({
    ifcType: 'IfcSpace',
    globalId: '0RSwXnbbzCWw8lcMd1dR9z',
    name: 'Wohnzimmer',
    quantities: { Qto_SpaceBaseQuantities: { FinishCeilingHeight: 2.4, NetFloorArea: 32 } },
  }),
  element({
    ifcType: 'IfcStairFlight',
    globalId: '3aB9Kz1Uv7wxKQ8bqZ3aB2',
    name: 'Treppe Ost',
    properties: { Pset_StairFlightCommon: { RiserHeight: 0.18, TreadLength: 0.28 } },
  }),
  element({
    ifcType: 'IfcWindow',
    globalId: '4cD0Lz2Vw8xyLR9crA4bC3',
    name: 'F-01',
    properties: { Pset_WindowCommon: { ThermalTransmittance: 1.1 } },
  }),
]

const FACTS = { gebaeudeklasse: 4 as const, hauptnutzung: 'wohnen', storeys: STOREYS }

describe('projected rule inputs', () => {
  it('produces exactly the verdicts the full elements produce', () => {
    // The whole justification for the fast path. Compared over the entire
    // catalogue rather than one rule, because a key dropped from the
    // projection would show up as a single rule quietly going undecidable.
    const stored = readStoredRuleInputs(buildStoredRuleInputs(MODEL, false))

    expect(runBimRules(stored!.elements, FACTS)).toEqual(runBimRules(MODEL, FACTS))
  })

  it('covers every key the catalogue reads', () => {
    // A rule that starts reading a key absent from the projection would see
    // `undefined` on the fast path and the real value on the slow one — the
    // same model answering two ways depending on which path served it. This
    // fails the moment a new rule needs a new key.
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'bim', 'rules.ts'), 'utf8')
    const read = new Set(
      [...source.matchAll(/(?:property|numericProperty|quantity)\(element, \[([^\]]*)\]/g)]
        .flatMap((match) => [...match[1].matchAll(/'([A-Za-z]+)'/g)].map((k) => k[1]))
    )
    const missing = [...read].filter((key) => !RULE_INPUT_KEYS.includes(key))

    expect(missing).toEqual([])

    // And the fields read straight off the element, not through a Pset. This
    // is the one that actually bit: the door rule reads
    // `element.predefinedType`, which no property-key scan would ever see.
    const fields = new Set(
      [...source.matchAll(/element\.([a-zA-Z]+)/g)].map((match) => match[1])
    )
    const missingFields = [...fields].filter(
      (field) => !RULE_INPUT_FIELDS.includes(field) && field !== 'ifcType'
    )

    expect(missingFields).toEqual([])
  })

  it('drops the payload the rules never read', () => {
    const [compact] = projectRuleInputs([MODEL[0]]) as unknown as Array<Record<string, unknown>>
    const properties = compact.p as Record<string, Record<string, unknown>>

    // Vendor sets with no wanted key disappear entirely.
    expect(Object.keys(properties)).toEqual(['Pset_WallCommon'])
    // And inside a kept set, only the wanted keys survive.
    expect(Object.keys(properties.Pset_WallCommon).sort()).toEqual([
      'AcousticRating',
      'FireRating',
      'IsExternal',
      'LoadBearing',
      'ThermalTransmittance',
    ])
  })

  it('is materially smaller than the rows it replaces', () => {
    const before = JSON.stringify(MODEL).length
    const after = JSON.stringify(buildStoredRuleInputs(MODEL, false)).length

    expect(after).toBeLessThan(before / 2)
  })

  it('carries the truncation flag, so a capped run stays capped', () => {
    expect(readStoredRuleInputs(buildStoredRuleInputs(MODEL, true))?.truncated).toBe(true)
  })

  it('refuses a projection from an older schema', () => {
    // Serving one written before a key was added would answer `undefined`
    // where the model has a value.
    const stale = { ...buildStoredRuleInputs(MODEL, false), version: 0 }

    expect(readStoredRuleInputs(stale)).toBeNull()
  })

  it('refuses anything that is not a projection', () => {
    expect(readStoredRuleInputs(null)).toBeNull()
    expect(readStoredRuleInputs('nope')).toBeNull()
    expect(readStoredRuleInputs({ version: 1 })).toBeNull()
  })
})
