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
  buildSearchKeys,
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

/**
 * The GIN pre-filter's shadow of `properties` and `quantities`.
 *
 * A key this omits is a candidate the index cannot offer, which costs only
 * speed — the exact unnest still decides. A key it gets WRONG is worse than
 * useless: the pre-filter is AND-ed in, so a mis-cased or mis-prefixed key
 * makes matching elements vanish from the answer. Everything below is about
 * that direction.
 *
 * The other half of the contract — that this agrees with the SQL backfill in
 * `0038_bim_element_search_keys.sql` — is checked against a real Postgres in
 * `query.integration.spec.ts`, because only Postgres can say what its own
 * `#>> '{}'` renders.
 */
describe('search keys', () => {
  it('emits the bare key and the set-qualified key, both lowercased', () => {
    // The bare key answers `{name: 'FireRating'}`; the dotted one answers
    // `{set: 'Pset_WallCommon', name: 'FireRating'}`. A filter may give either.
    const keys = buildSearchKeys(
      element({ ifcType: 'IfcWall', properties: { Pset_WallCommon: { FireRating: 'REI 90' } } })
    )

    expect(keys).toEqual({
      'p:firerating': ['rei 90'],
      'p:pset_wallcommon.firerating': ['rei 90'],
    })
  })

  it('separates quantities from properties', () => {
    // `Width` is both a Pset property and a Qto quantity in real exports, and
    // a filter names which one it means. Collapsing them would let a property
    // filter be pre-filtered away by a quantity's presence, and vice versa.
    const keys = buildSearchKeys(
      element({
        ifcType: 'IfcDoor',
        properties: { Pset_DoorCommon: { Width: 0.9 } },
        quantities: { Qto_DoorBaseQuantities: { Width: 0.91 } },
      })
    )

    expect(Object.keys(keys).sort()).toEqual([
      'p:pset_doorcommon.width',
      'p:width',
      'q:qto_doorbasequantities.width',
      'q:width',
    ])
    expect(keys['p:width']).toEqual(['0.9'])
    expect(keys['q:width']).toEqual(['0.91'])
  })

  it('collects every value a bare key takes across sets', () => {
    // Two sets carrying the same property name is why the map holds arrays.
    // Keeping only one would drop the other set's elements from an `eq`
    // pre-filter that AND-s containment.
    const keys = buildSearchKeys(
      element({
        ifcType: 'IfcWall',
        properties: {
          Pset_WallCommon: { FireRating: 'REI 90' },
          'Revit Type Parameters': { FireRating: 'F90' },
        },
      })
    )

    expect(keys['p:firerating'].sort()).toEqual(['f90', 'rei 90'])
  })

  it('renders booleans and numbers the way the SQL does', () => {
    // `p.prop_value #>> '{}'` gives `true` and `0.21`, not `TRUE` or `.21`.
    // The filter side lowercases the same way, so these have to match exactly.
    const keys = buildSearchKeys(
      element({
        ifcType: 'IfcWall',
        properties: { Pset_WallCommon: { IsExternal: true, ThermalTransmittance: 0.21 } },
      })
    )

    expect(keys['p:isexternal']).toEqual(['true'])
    expect(keys['p:thermaltransmittance']).toEqual(['0.21'])
  })

  it('keeps the KEY of a null-valued property but not a value for it', () => {
    // Both halves, and they pull opposite ways. `{operator: 'exists'}` checks
    // only the property NAME, so a null-valued FireRating matches it — and a
    // pre-filter that omitted the key would delete that element from an answer
    // the exact predicate matched. But `#>> '{}'` over a jsonb null is SQL
    // NULL, so no `eq` can match it either, and a literal `"null"` in the
    // value list would let containment claim a match the predicate refuses.
    const keys = buildSearchKeys(
      element({ ifcType: 'IfcWall', properties: { Pset_WallCommon: { FireRating: null } } })
    )

    expect(keys).toEqual({ 'p:firerating': [], 'p:pset_wallcommon.firerating': [] })
  })

  it('keeps the real values when one set is null and another is not', () => {
    const keys = buildSearchKeys(
      element({
        ifcType: 'IfcWall',
        properties: {
          Pset_WallCommon: { FireRating: null },
          'Revit Type Parameters': { FireRating: 'F90' },
        },
      })
    )

    expect(keys['p:firerating']).toEqual(['f90'])
    expect(keys['p:pset_wallcommon.firerating']).toEqual([])
  })

  it('gives an element with no properties an empty map, not null', () => {
    // `{}` means "indexed, carries nothing"; NULL means "not indexed yet" and
    // switches the pre-filter off for that row. They must not be confused.
    expect(buildSearchKeys(element({ ifcType: 'IfcSite' }))).toEqual({})
  })
})
