/**
 * The rule catalog.
 *
 * Every assertion here is about one of the three ways a compliance checker can
 * be dangerous:
 *
 *  1. Calling a missing value a pass — the model is 60% property-complete and
 *     the building comes back green.
 *  2. Reading a unit wrong — a door width of 900 mm read as 900 m passes every
 *     threshold ever written.
 *  3. Comparing the wrong thing — `EI 90` on a load-bearing wall is not `R 90`,
 *     and matching on the number alone would say it is.
 *
 * The pass cases are almost incidental. These are the failure modes.
 */

import { describe, expect, it } from 'vitest'
import {
  attachConfirmations,
  outstandingRules,
  BIM_RULES,
  diffBimCompliance,
  ifcTypeVariants,
  renderBimComplianceDiff,
  missingPropertyShoppingList,
  renderBimRules,
  runBimRules,
  summarizeBimRules,
} from './rules'
import type { BimElement } from './types'

function element(overrides: Partial<BimElement> & Pick<BimElement, 'ifcType'>): BimElement {
  return {
    globalId: `g-${overrides.name ?? overrides.ifcType}`,
    expressId: 1,
    name: null,
    description: null,
    predefinedType: null,
    objectType: null,
    tag: null,
    typeName: null,
    containerKind: 'storey',
    containerGlobalId: null,
    containerName: 'Erdgeschoss',
    storeyGlobalId: 's-eg',
    storeyName: 'Erdgeschoss',
    materials: [],
    classifications: [],
    properties: {},
    quantities: {},
    ...overrides,
  }
}

const ruleOf = (results: ReturnType<typeof runBimRules>, id: string) => {
  const found = results.find((result) => result.ruleId === id)
  if (!found) throw new Error(`no such rule: ${id}`)
  return found
}

/**
 * Storey elevations, because OIB 2 Tabelle 1b asks a different duration of a
 * Kellergeschoß wall than of a ground-floor one. The fixture element sits on
 * `Erdgeschoss`; `Obergeschoss` is the topmost and `Keller` is below ground.
 */
const STOREYS = [
  { name: 'Keller', elevation: -2.8 },
  { name: 'Erdgeschoss', elevation: 0 },
  { name: 'Obergeschoss', elevation: 3 },
]

describe('an unmeasured dimension is not a measurement of zero', () => {
  /*
    The parser substitutes `0` for a quantity written `$`, and `ClearWidth`,
    `FinishCeilingHeight`, `RiserHeight` and `TreadLength` — the PREFERRED keys
    of every dimensional rule — fell outside the extractor's zero-means-absent
    pattern, which only covered `Net`/`Gross` prefixes. Read as a measurement,
    an unmeasured clear width produces "Lichte Durchgangsbreite 0,00 m — nicht
    erfüllt" on an escape-route rule, for a door nobody has measured; and
    because `missing` is recorded only for undecidable elements, the shopping
    list left out the property that would settle it.

    Fixed in `extract.ts` for new uploads, and here for the rows already stored
    under the old rule.
  */
  const door = (quantities: Record<string, number>): BimElement =>
    element({
      ifcType: 'IfcDoor',
      name: 'Tür 01',
      predefinedType: 'DOOR',
      quantities: { Qto_DoorBaseQuantities: quantities },
    })

  it('does not fail a door on a ClearWidth of zero', () => {
    const rule = ruleOf(
      runBimRules([door({ ClearWidth: 0, Width: 900 })], { lengthScale: 0.001 }),
      'oib4-tuer-durchgangsbreite'
    )
    expect(rule.failed).toBe(0)
    // It falls through to the nominal width, which is what the rule is for.
    expect(rule.passed + rule.undecidable).toBe(1)
  })

  it('asks for the clear width rather than reporting 0,00 m', () => {
    const rule = ruleOf(
      runBimRules([door({ ClearWidth: 0 })], { lengthScale: 0.001 }),
      'oib4-tuer-durchgangsbreite'
    )
    expect(rule.failed).toBe(0)
    expect(rule.undecidable).toBe(1)
    expect(rule.unknowns[0]?.reading).not.toContain('0,00')
    expect(rule.missing.map((entry) => entry.path)).toContain(
      'Qto_DoorBaseQuantities.ClearWidth'
    )
  })

  it('does not fail a room on a FinishCeilingHeight of zero', () => {
    const room = element({
      ifcType: 'IfcSpace',
      name: 'Wohnen',
      quantities: { Qto_SpaceBaseQuantities: { FinishCeilingHeight: 0 } },
    })
    const rule = ruleOf(runBimRules([room], { lengthScale: 1 }), 'oib3-raumhoehe')
    expect(rule.failed).toBe(0)
    expect(rule.undecidable).toBe(1)
  })
})

describe('OIB 2 Tabelle 1b, row 1 — the storey decides the duration', () => {
  const wallOn = (storeyName: string, rating: string) =>
    element({
      ifcType: 'IfcWall',
      name: `W-${storeyName}`,
      storeyName,
      properties: { Pset_WallCommon: { LoadBearing: true, FireRating: rating } },
    })
  const fire = (elements: ReturnType<typeof element>[], gebaeudeklasse: 1 | 2 | 3 | 4 | 5) =>
    runBimRules(elements, { gebaeudeklasse, storeys: STOREYS }).filter(
      (r) => r.ruleId === 'oib2-feuerwiderstand-tragend'
    )[0]

  it('fails a Kellergeschoß wall that would pass above ground', () => {
    // Row 1.3: GK3 and up need R 90 in a basement, where row 1.2 asks R 60.
    // The catalogue only had the above-ground row, so this wall passed.
    const rule = fire([wallOn('Keller', 'R 60')], 3)

    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('erforderlich R 90')
    expect(rule.failures[0].reading).toContain('Kellergeschoß')
  })

  it('still passes the same wall on the ground floor', () => {
    expect(fire([wallOn('Erdgeschoss', 'R 60')], 3).passed).toBe(1)
  })

  it('asks only R 60 of a Kellergeschoß wall in GK1 and GK2', () => {
    expect(fire([wallOn('Keller', 'R 60')], 2).passed).toBe(1)
    expect(fire([wallOn('Keller', 'R 30')], 2).failed).toBe(1)
  })

  it('applies the lighter top-storey row to the topmost storey', () => {
    // Row 1.1: GK4 asks R 30 at the top where row 1.2 asks R 60. Using the
    // stricter row everywhere would fail a correct top-floor wall.
    expect(fire([wallOn('Obergeschoss', 'R 30')], 4).passed).toBe(1)
    expect(fire([wallOn('Erdgeschoss', 'R 30')], 4).failed).toBe(1)
  })

  it('asks nothing of the top storey in GK1', () => {
    expect(fire([wallOn('Obergeschoss', 'R 0')], 1).passed).toBe(1)
  })

  it('refuses to guess when the model publishes no storey elevations', () => {
    // Picking the above-ground row would pass a basement wall needing twice
    // the duration; picking the top row would fail a correct one. Neither
    // guess is safe, so the requirement is simply not determined.
    const rule = runBimRules([wallOn('Keller', 'R 60')], { gebaeudeklasse: 3 }).filter(
      (r) => r.ruleId === 'oib2-feuerwiderstand-tragend'
    )[0]

    expect(rule.undecidable).toBe(1)
    expect(rule.missing[0].path).toContain('Elevation')
  })

  it('does not judge a Decke by row 1 at all', () => {
    // Tabelle 1b row 1 excludes Decken by its own title; they are row 4.
    const rule = runBimRules(
      [
        element({
          ifcType: 'IfcSlab',
          name: 'Decke',
          storeyName: 'Erdgeschoss',
          properties: { Pset_SlabCommon: { LoadBearing: true, FireRating: 'R 30' } },
        }),
      ],
      { gebaeudeklasse: 5, storeys: STOREYS }
    ).filter((r) => r.ruleId === 'oib2-feuerwiderstand-tragend')[0]

    expect(rule.passed + rule.failed + rule.undecidable).toBe(0)
  })
})

describe('rules that never matched, and ticks that were not earned', () => {
  it('checks an IFC4 IfcDoorStandardCase like any other door', () => {
    // ArchiCAD writes this routinely. The catalogue listed `IfcDoor` only, so
    // the door rule matched zero elements and the Prüfbuch had nothing to say
    // about any door in the building — silence, not a verdict.
    const [rule] = runBimRules(
      [
        element({
          ifcType: 'IfcDoorStandardCase',
          name: 'T-14',
          quantities: { Qto_DoorBaseQuantities: { Width: 700 } },
        }),
      ],
      {}
    ).filter((r) => r.ruleId === 'oib4-tuer-durchgangsbreite')

    expect(rule.passed + rule.failed + rule.undecidable).toBe(1)
    expect(rule.failed).toBe(1)
  })

  it('checks an ElementedCase wall too', () => {
    const [rule] = runBimRules(
      [
        element({
          ifcType: 'IfcWallElementedCase',
          name: 'Aussenwand',
          properties: { Pset_WallCommon: { IsExternal: true, ThermalTransmittance: 0.5 } },
        }),
      ],
      { hauptnutzung: 'wohnen' }
    ).filter((r) => r.ruleId === 'oib6-u-wert-aussenwand')

    expect(rule.failed).toBe(1)
  })

  it('does not count a requirement with unknowns left as erfüllt', () => {
    // 9 passed + 2 undecidable rendered a green "Erfüllt" badge. The two
    // unknowns are the reason the requirement is not settled.
    const summary = summarizeBimRules([
      {
        ruleId: 'r',
        richtlinie: 'OIB 3',
        clause: '2',
        titleDe: 't',
        thresholdDe: 's',
        applicable: true,
        passed: 9,
        failed: 0,
        undecidable: 2,
        failures: [],
        unknowns: [],
        truncated: false,
        missing: [],
      },
    ])

    expect(summary.rulesPassing).toBe(0)
    expect(summary.rulesUndecidable).toBe(1)
  })

  it('still counts a fully settled requirement as erfüllt', () => {
    const summary = summarizeBimRules([
      {
        ruleId: 'r',
        richtlinie: 'OIB 3',
        clause: '2',
        titleDe: 't',
        thresholdDe: 's',
        applicable: true,
        passed: 9,
        failed: 0,
        undecidable: 0,
        failures: [],
        unknowns: [],
        truncated: false,
        missing: [],
      },
    ])

    expect(summary.rulesPassing).toBe(1)
  })
})

describe('false verdicts a reviewer found by running the catalogue', () => {
  const facts = { gebaeudeklasse: 4 as const, storeys: STOREYS }

  it('asks R of a column, not REI — a linear member cannot separate', () => {
    // `R 90` on a column is a correct declaration. Requiring REI of it (the
    // criteria a WALL needs) reported it as nicht erfüllt, sending an
    // architect to argue with a Brandschutzplaner about a column that was
    // right, and teaching them to distrust the whole Prüfbuch.
    const [rule] = runBimRules(
      [
        element({
          ifcType: 'IfcColumn',
          name: 'Stuetze EG',
          properties: { Pset_ColumnCommon: { LoadBearing: true, FireRating: 'R 90' } },
        }),
      ],
      facts
    ).filter((r) => r.ruleId === 'oib2-feuerwiderstand-tragend')

    expect(rule.failed).toBe(0)
    expect(rule.passed).toBe(1)
  })

  it('asks R of a load-bearing WALL too — row 1 never says REI', () => {
    const [rule] = runBimRules(
      [
        element({
          ifcType: 'IfcWall',
          name: 'Wand',
          properties: { Pset_WallCommon: { LoadBearing: true, FireRating: 'R 90' } },
        }),
      ],
      facts
    ).filter((r) => r.ruleId === 'oib2-feuerwiderstand-tragend')

    // Tabelle 1b row 1 is "tragende Bauteile (ausgenommen Decken und
    // brandabschnittsbildende Wände)" and asks R throughout. REI belongs to
    // rows 2 and 3, which are different components. Demanding REI here failed
    // a correctly declared load-bearing wall.
    expect(rule.failed).toBe(0)
    expect(rule.passed).toBe(1)
  })

  it('does not let a wall vanish because nobody said whether it is load-bearing', () => {
    // The scope predicate used to be `LoadBearing === true`, so an unstated
    // wall left the rule's scope entirely — not undecidable, not counted,
    // simply absent from a fire-resistance check.
    const [rule] = runBimRules(
      [
        element({
          ifcType: 'IfcWall',
          name: 'Wand ohne Angabe',
          properties: { Pset_WallCommon: { FireRating: 'REI 90' } },
        }),
      ],
      facts
    ).filter((r) => r.ruleId === 'oib2-feuerwiderstand-tragend')

    expect(rule.undecidable).toBe(1)
    expect(rule.unknowns[0].reading).toMatch(/tragend/i)
    expect(rule.missing.some((m) => m.path.includes('LoadBearing'))).toBe(true)
  })

  it('keeps a wall that says it is NOT load-bearing out of scope', () => {
    const [rule] = runBimRules(
      [
        element({
          ifcType: 'IfcWall',
          name: 'Trennwand',
          properties: { Pset_WallCommon: { LoadBearing: false } },
        }),
      ],
      facts
    ).filter((r) => r.ruleId === 'oib2-feuerwiderstand-tragend')

    expect(rule.passed + rule.failed + rule.undecidable).toBe(0)
  })

  it('refuses U = 0 rather than calling it the best wall ever built', () => {
    const [rule] = runBimRules(
      [
        element({
          ifcType: 'IfcWall',
          name: 'Aussenwand',
          properties: { Pset_WallCommon: { IsExternal: true, ThermalTransmittance: 0 } },
        }),
      ],
      { hauptnutzung: 'wohnen' }
    ).filter((r) => r.ruleId === 'oib6-u-wert-aussenwand')

    expect(rule.passed).toBe(0)
    expect(rule.undecidable).toBe(1)
  })

  it('refuses a window U of 0 the same way', () => {
    const [rule] = runBimRules(
      [
        element({
          ifcType: 'IfcWindow',
          name: 'Fenster',
          properties: { Pset_WindowCommon: { ThermalTransmittance: 0 } },
        }),
      ],
      { hauptnutzung: 'wohnen' }
    ).filter((r) => r.ruleId === 'oib6-u-wert-fenster')

    expect(rule.passed).toBe(0)
    expect(rule.undecidable).toBe(1)
  })

  it('refuses a declared Schalldämm-Maß of 0', () => {
    // The rule only claims "a value was declared" — so it must not accept the
    // value an exporter writes when nobody declared one.
    const [rule] = runBimRules(
      [
        element({
          ifcType: 'IfcWall',
          name: 'Wohnungstrennwand',
          properties: { Pset_WallCommon: { AcousticRating: 0 } },
        }),
      ],
      { hauptnutzung: 'wohnen' }
    ).filter((r) => r.ruleId === 'oib5-schalldaemmung-deklariert')

    expect(rule.passed).toBe(0)
    expect(rule.undecidable).toBe(1)
  })

  it('still accepts a real Schalldämm-Maß', () => {
    const [rule] = runBimRules(
      [
        element({
          ifcType: 'IfcWall',
          name: 'Wohnungstrennwand',
          properties: { Pset_WallCommon: { AcousticRating: 55 } },
        }),
      ],
      { hauptnutzung: 'wohnen' }
    ).filter((r) => r.ruleId === 'oib5-schalldaemmung-deklariert')

    expect(rule.passed).toBe(1)
  })
})

/**
 * The same normalisation, one layer out.
 *
 * The catalogue learned to read `IfcDoorStandardCase` as a door; the QUERY
 * layer — which every question the agent asks goes through — kept matching
 * `lower(ifc_type)` exactly. An IFC4 export whose walls are
 * `IfcWallStandardCase` answered a filter for `IfcWall` with nothing, and the
 * agent reported a building with no walls in it.
 */
describe('the spellings one requested IFC type can have', () => {
  it('expands a plain type to the IFC4 subtypes an exporter may have written', () => {
    expect(ifcTypeVariants('IfcWall')).toEqual([
      'ifcwall',
      'ifcwallstandardcase',
      'ifcwallelementedcase',
    ])
  })

  it('matches the plain type when the caller named a subtype', () => {
    // The caller is naming a kind of component, not an exporter's choice.
    expect(ifcTypeVariants('IfcDoorStandardCase')).toContain('ifcdoor')
  })

  it('is case-insensitive, like the column comparison it feeds', () => {
    expect(ifcTypeVariants('IFCSLAB')).toContain('ifcslab')
  })
})

describe('the catalog itself', () => {
  it('has a unique id, a Richtlinie and a visible threshold on every rule', () => {
    const ids = BIM_RULES.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const rule of BIM_RULES) {
      // The threshold is rendered next to every verdict so the architect can
      // check the RULE, not just the result. A rule without one is a rule that
      // asks to be trusted.
      expect(rule.thresholdDe.length).toBeGreaterThan(0)
      expect(rule.richtlinie).toMatch(/^OIB /)
      expect(rule.clause.length).toBeGreaterThan(0)
    }
  })

  it('reads no geometry — every rule is decidable from published values', () => {
    // The server holds no coordinates, solids or opening graph. A rule that
    // needed them could only guess, so the catalog must contain none. This is
    // pinned as a list rather than a mechanism because the guarantee is a
    // review decision, not something the type system can express.
    expect(BIM_RULES.map((rule) => rule.id).sort()).toEqual([
      'oib2-feuerwiderstand-tragend',
      'oib3-raumhoehe',
      'oib4-treppe-steigungsverhaeltnis',
      'oib4-tuer-durchgangsbreite',
      'oib5-schalldaemmung-deklariert',
      'oib6-u-wert-aussenwand',
      'oib6-u-wert-fenster',
    ])
  })
})

describe('a missing value is never a pass', () => {
  it('reports undecidable, not pass, for every rule whose value is absent', () => {
    const bare = [
      element({ ifcType: 'IfcStairFlight', name: 'T1' }),
      element({ ifcType: 'IfcDoor', name: 'D1' }),
      element({ ifcType: 'IfcSpace', name: 'Wohnen' }),
      element({ ifcType: 'IfcWall', name: 'W1', properties: { Pset_WallCommon: { LoadBearing: true } } }),
      element({ ifcType: 'IfcWall', name: 'W2', properties: { Pset_WallCommon: { IsExternal: true } } }),
      element({ ifcType: 'IfcWindow', name: 'F1' }),
    ]
    const results = runBimRules(bare, { gebaeudeklasse: 3, hauptnutzung: 'wohnen' })
    for (const result of results.filter((entry) => entry.applicable)) {
      expect(result.passed, `${result.ruleId} must not pass a bare element`).toBe(0)
    }
    expect(summarizeBimRules(results).elementsUndecidable).toBeGreaterThan(0)
  })

  it('names the exact property that would settle each undecidable verdict', () => {
    const results = runBimRules(
      [element({ ifcType: 'IfcWall', name: 'W1', properties: { Pset_WallCommon: { LoadBearing: true } } })],
      { gebaeudeklasse: 5, storeys: STOREYS }
    )
    const rule = ruleOf(results, 'oib2-feuerwiderstand-tragend')
    expect(rule.undecidable).toBe(1)
    expect(rule.missing[0].path).toContain('FireRating')
    // The reading still states the requirement, so the row is actionable even
    // before the property exists.
    expect(rule.unknowns[0].reading).toContain('R 90')
  })
})

describe('units', () => {
  it('reads a door width in millimetres as metres', () => {
    // 900 read as 900 m would clear every threshold ever written.
    const results = runBimRules([
      element({ ifcType: 'IfcDoor', name: 'D1', quantities: { Qto_DoorBaseQuantities: { ClearWidth: 900 } } }),
    ])
    const rule = ruleOf(results, 'oib4-tuer-durchgangsbreite')
    expect(rule.passed).toBe(1)
    expect(rule.failures).toHaveLength(0)
  })

  it('reads the same width expressed in metres identically', () => {
    const results = runBimRules([
      element({ ifcType: 'IfcDoor', name: 'D1', quantities: { Qto_DoorBaseQuantities: { ClearWidth: 0.9 } } }),
    ])
    expect(ruleOf(results, 'oib4-tuer-durchgangsbreite').passed).toBe(1)
  })

  it('still fails a genuinely narrow door in either unit', () => {
    for (const width of [700, 0.7]) {
      const results = runBimRules([
        element({ ifcType: 'IfcDoor', name: 'D1', quantities: { Qto_DoorBaseQuantities: { Width: width } } }),
      ])
      const rule = ruleOf(results, 'oib4-tuer-durchgangsbreite')
      expect(rule.failed, `width ${width}`).toBe(1)
      expect(rule.failures[0].reading).toContain('0,80')
    }
  })
})

describe('oib4-treppe-steigungsverhaeltnis', () => {
  const stair = (riser: number, tread: number) =>
    element({
      ifcType: 'IfcStairFlight',
      name: 'T1',
      properties: { Pset_StairFlightCommon: { RiserHeight: riser, TreadLength: tread } },
    })

  it('accepts a comfortable stair and shows the arithmetic', () => {
    const rule = ruleOf(runBimRules([stair(0.17, 0.29)]), 'oib4-treppe-steigungsverhaeltnis')
    expect(rule.passed).toBe(1)
  })

  it('rejects a stair outside the band and names the band', () => {
    const rule = ruleOf(runBimRules([stair(0.2, 0.24)]), 'oib4-treppe-steigungsverhaeltnis')
    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('2h + b')
    expect(rule.failures[0].reading).toContain('59–65 cm')
  })

  it('rejects a stair whose ratio is in band but whose riser is too high', () => {
    // 2*19 + 25 = 63, inside the band, but a 19 cm riser is not permitted —
    // checking only the sum would pass this.
    const rule = ruleOf(runBimRules([stair(0.19, 0.25)]), 'oib4-treppe-steigungsverhaeltnis')
    expect(rule.failed).toBe(1)
  })
})

describe('oib2-feuerwiderstand-tragend', () => {
  const wall = (rating: string | null, loadBearing = true) =>
    element({
      ifcType: 'IfcWall',
      name: 'W1',
      properties: {
        Pset_WallCommon: {
          LoadBearing: loadBearing,
          ...(rating === null ? {} : { FireRating: rating }),
        },
      },
    })

  it('passes a wall that meets its Gebäudeklasse', () => {
    const rule = ruleOf(runBimRules([wall('REI 90')], { gebaeudeklasse: 5, storeys: STOREYS }), 'oib2-feuerwiderstand-tragend')
    expect(rule.passed).toBe(1)
  })

  it('fails a wall that is short of the minutes', () => {
    const rule = ruleOf(runBimRules([wall('REI 30')], { gebaeudeklasse: 5, storeys: STOREYS }), 'oib2-feuerwiderstand-tragend')
    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('erforderlich R 90')
  })

  it('fails a rating with enough minutes but the wrong criteria', () => {
    // EI 90 is not R 90: the wall is load-bearing and the declaration says
    // nothing about load-bearing behaviour. Comparing 90 >= 90 alone would
    // call this compliant.
    const rule = ruleOf(runBimRules([wall('EI 90')], { gebaeudeklasse: 5, storeys: STOREYS }), 'oib2-feuerwiderstand-tragend')
    expect(rule.failed).toBe(1)
  })

  it('ignores non-load-bearing walls entirely', () => {
    const rule = ruleOf(
      runBimRules([wall(null, false)], { gebaeudeklasse: 5, storeys: STOREYS }),
      'oib2-feuerwiderstand-tragend'
    )
    expect(rule.passed + rule.failed + rule.undecidable).toBe(0)
  })

  it('cannot decide without the Gebäudeklasse — and says that, not "nicht einschlägig"', () => {
    /*
      Assuming GK1 would turn a GK5 building's missing R 90 into a pass, so
      standing down is right. WHICH stand-down was not: this used to report
      `applicable: false`, which the panel renders as the badge "Nicht
      einschlägig" — the rule does not apply to your building. It does apply;
      it cannot be evaluated. And `rulesWithOpenWork` / `outstandingRules` both
      drop inapplicable rules, so the fire rule disappeared from "what still
      needs a human before this can be signed" and its walls never reached the
      BCF export. One unset project fact removed OIB 2 from the Prüfbuch.
    */
    // Storeys supplied, so the only thing missing is the Gebäudeklasse and
    // the reading names it rather than the storey.
    const rule = ruleOf(
      runBimRules([wall('R 30')], { storeys: STOREYS }),
      'oib2-feuerwiderstand-tragend'
    )
    expect(rule.applicable).toBe(true)
    expect(rule.passed).toBe(0)
    expect(rule.failed).toBe(0)
    expect(rule.undecidable).toBe(1)
    expect(rule.unknowns[0]?.reading).toContain('Gebäudeklasse unbekannt')
    // And the fact itself lands on the shopping list, which is the only place
    // that tells the reader what would settle it.
    expect(rule.missing.map((entry) => entry.path)).toContain('Projektangabe: Gebäudeklasse')
  })

  it('refuses to call every storey the top one when the export wrote no elevations', () => {
    /*
      The classic broken export: `0.` for every `IfcBuildingStorey.Elevation`.
      Every storey then equalled the maximum, so every storey classified as
      `top` — the Kellergeschoß included — and `top` being non-null meant the
      undecidable guard never fired. On GK1, whose top row carries no
      requirement at all, three load-bearing walls with no FireRating came back
      as three PASSES. "No contradiction found" rendered as compliant, on the
      fire rule.
    */
    const flat = [
      { name: 'Kellergeschoß', elevation: 0 },
      { name: 'Erdgeschoß', elevation: 0 },
      { name: '1.Obergeschoß', elevation: 0 },
    ]
    const walls = flat.map((storey, index) => ({
      ...wall(null),
      globalId: `w-${index}`,
      storeyName: storey.name,
    }))
    const rule = ruleOf(
      runBimRules(walls, { gebaeudeklasse: 1, storeys: flat }),
      'oib2-feuerwiderstand-tragend'
    )

    expect(rule.passed).toBe(0)
    expect(rule.undecidable).toBe(3)
    expect(rule.unknowns[0]?.reading).toContain('Geschoßlage')
  })

  it('still names the top storey when the stack has real elevations', () => {
    // The guard must not cost the ordinary case its answer.
    const stack = [
      { name: 'Erdgeschoß', elevation: 0 },
      { name: '1.Obergeschoß', elevation: 3 },
    ]
    const rule = ruleOf(
      runBimRules([{ ...wall(null), storeyName: '1.Obergeschoß' }], {
        gebaeudeklasse: 1,
        storeys: stack,
      }),
      'oib2-feuerwiderstand-tragend'
    )
    expect(rule.passed).toBe(1)
  })

  it('does not cry wolf over the older F-classification', () => {
    // F 90 is the older Austrian/German designation and DOES mean load-bearing
    // 90 minutes. Scoring it against REI 90 on letters would mark a compliant
    // wall as failing, and a checker that raises false alarms on fire ratings
    // is one nobody reads. The value is shown, the verdict is withheld.
    const rule = ruleOf(runBimRules([wall('F 90')], { gebaeudeklasse: 5, storeys: STOREYS }), 'oib2-feuerwiderstand-tragend')
    expect(rule.failed).toBe(0)
    expect(rule.undecidable).toBe(1)
    expect(rule.unknowns[0].reading).toContain('F 90')
    expect(rule.unknowns[0].reading).toContain('manuell')
  })

  it('refuses to pick a side of a combined declaration', () => {
    // `R 30 / EI 90` carries two performances for two situations, and taking
    // whichever number comes first reports the wall as failing REI 60 when it
    // may be fine — or the reverse.
    for (const combined of ['R 30 / EI 90', 'REI 90/EI 30', 'R 30 und EI 90']) {
      const rule = ruleOf(
        runBimRules([wall(combined)], { gebaeudeklasse: 3, storeys: STOREYS }),
        'oib2-feuerwiderstand-tragend'
      )
      expect(rule.undecidable, combined).toBe(1)
      expect(rule.failed, combined).toBe(0)
    }
  })

  it('still fails a genuine European shortfall rather than hiding behind unreadable', () => {
    // The escape hatch must not swallow real failures: REI 30 against REI 90 is
    // comparable and short.
    expect(
      ruleOf(runBimRules([wall('REI 30')], { gebaeudeklasse: 5, storeys: STOREYS }), 'oib2-feuerwiderstand-tragend').failed
    ).toBe(1)
  })

  it('reports an unreadable rating as undecidable, not as a failure', () => {
    const rule = ruleOf(
      runBimRules([wall('feuerhemmend')], { gebaeudeklasse: 3, storeys: STOREYS }),
      'oib2-feuerwiderstand-tragend'
    )
    expect(rule.undecidable).toBe(1)
    expect(rule.failed).toBe(0)
  })
})

describe('reading a number out of a string a CAD wrote', () => {
  const wall = (uValue: string | number) =>
    element({
      ifcType: 'IfcWall',
      name: 'AW',
      properties: { Pset_WallCommon: { IsExternal: true, ThermalTransmittance: uValue } },
    })

  it('does not concatenate digits that were never part of the value', () => {
    // The regression: stripping non-numerics turns `0,35 W/m2K` into 0.352,
    // which fails a ≤ 0,35 check. A compliant wall reported as non-compliant
    // because the exporter spelled the unit with an ASCII 2.
    for (const written of ['0,35 W/m2K', '0.35 W/m²K', '0,35', 0.35, '0.35 W/(m2.K)']) {
      const rule = ruleOf(runBimRules([wall(written)]), 'oib6-u-wert-aussenwand')
      expect(rule.passed, `written as ${JSON.stringify(written)}`).toBe(1)
    }
  })

  it('still fails a genuinely high U-value written the same way', () => {
    expect(ruleOf(runBimRules([wall('0,45 W/m2K')]), 'oib6-u-wert-aussenwand').failed).toBe(1)
  })

  it('refuses a string that does not start with a number', () => {
    // `Klasse 2 gemäß ÖNORM` must not be mined for a `2`.
    const rule = ruleOf(runBimRules([wall('Klasse 2 gemäß ÖNORM')]), 'oib6-u-wert-aussenwand')
    expect(rule.undecidable).toBe(1)
    expect(rule.passed + rule.failed).toBe(0)
  })
})

describe('the declared unit beats the guess', () => {
  const door = (width: number) =>
    element({ ifcType: 'IfcDoor', name: 'D1', quantities: { Qto_DoorBaseQuantities: { ClearWidth: width } } })

  it('uses the model\u2019s declared length scale when it has one', () => {
    // 0.9 in a MILLIMETRE model is 0.9 mm, not 0.9 m. The magnitude guess reads
    // it as metres and passes; the declaration is what makes this a failure.
    const guessed = ruleOf(runBimRules([door(0.9)]), 'oib4-tuer-durchgangsbreite')
    expect(guessed.passed).toBe(1)
    const declared = ruleOf(
      runBimRules([door(0.9)], { lengthScale: 0.001 }),
      'oib4-tuer-durchgangsbreite'
    )
    expect(declared.failed).toBe(1)
  })

  it('reads a metre-declared model literally', () => {
    const rule = ruleOf(runBimRules([door(900)], { lengthScale: 1 }), 'oib4-tuer-durchgangsbreite')
    // 900 m wide, which is absurd, but the model said metres and the checker
    // must not quietly overrule the declaration to make the answer sensible.
    expect(rule.passed).toBe(1)
    expect(rule.failed).toBe(0)
  })

  it('falls back to the magnitude guess when nothing is declared', () => {
    expect(ruleOf(runBimRules([door(900)]), 'oib4-tuer-durchgangsbreite').passed).toBe(1)
    expect(ruleOf(runBimRules([door(0.7)]), 'oib4-tuer-durchgangsbreite').failed).toBe(1)
  })
})

describe('oib4-tuer-durchgangsbreite', () => {
  const door = (quantities: Record<string, number>) =>
    element({ ifcType: 'IfcDoor', name: 'T-14', quantities: { Qto_DoorBaseQuantities: quantities } })

  it('reads the CLEAR width, not the nominal one, when both are published', () => {
    // The bug this rule shipped with. A 0,90 m door leaf passes through a
    // frame and over a stop; the clear opening is routinely 0,78 m. Reading
    // `Width` first passed the door — on an escape-route rule.
    const rule = ruleOf(runBimRules([door({ Width: 0.9, ClearWidth: 0.78 })]), 'oib4-tuer-durchgangsbreite')

    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('Lichte Durchgangsbreite')
  })

  it('will not call a door compliant on its nominal width alone', () => {
    // The nominal width is an UPPER BOUND on the clear one, so 0,90 m nominal
    // is consistent with both a compliant and a non-compliant door. Saying so
    // is the honest answer; a tick is a guess.
    const rule = ruleOf(runBimRules([door({ Width: 0.9 })]), 'oib4-tuer-durchgangsbreite')

    expect(rule.passed).toBe(0)
    expect(rule.undecidable).toBe(1)
    expect(rule.unknowns[0].reading).toContain('Nennbreite')
    expect(rule.missing[0].path).toContain('ClearWidth')
  })

  it('still settles a FAILURE from the nominal width', () => {
    // Being an upper bound is exactly what makes this direction safe: if even
    // the nominal width is under 0,80 m, the clear width certainly is.
    const rule = ruleOf(runBimRules([door({ Width: 0.7 })]), 'oib4-tuer-durchgangsbreite')

    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('Nennbreite')
  })

  it('says which property would settle it when nothing is published', () => {
    const rule = ruleOf(runBimRules([door({})]), 'oib4-tuer-durchgangsbreite')

    expect(rule.undecidable).toBe(1)
    expect(rule.missing[0].path).toBe('Qto_DoorBaseQuantities.ClearWidth')
  })
})

describe('oib3-raumhoehe', () => {
  const space = (name: string, height: number | null) =>
    element({
      ifcType: 'IfcSpace',
      name,
      predefinedType: 'INTERNAL',
      quantities: height === null ? {} : { Qto_SpaceBaseQuantities: { FinishCeilingHeight: height } },
    })

  it('checks an Aufenthaltsraum', () => {
    const rule = ruleOf(runBimRules([space('Wohnen', 2.6)]), 'oib3-raumhoehe')
    expect(rule.passed).toBe(1)
  })

  it('checks a room whose PredefinedType says nothing', () => {
    // `NOTDEFINED` is what Revit and ArchiCAD write for an ordinary room, and
    // `SPACE` is IFC4's own generic value. Reading either as "a type WAS
    // published and it is not one I recognise" put the majority of every real
    // model's rooms out of scope — the rule then reported nothing to check,
    // which reads as a building with no Aufenthaltsräume rather than as a
    // check that never ran.
    for (const predefinedType of ['NOTDEFINED', 'SPACE', 'USERDEFINED', null]) {
      const rule = ruleOf(
        runBimRules([{ ...space('Wohnen', 2.3), predefinedType }]),
        'oib3-raumhoehe'
      )
      expect(rule.failed, `predefinedType ${predefinedType}`).toBe(1)
    }
  })

  it('still believes a PredefinedType that means something', () => {
    // These are real statements about the room, and a garage is not an
    // Aufenthaltsraum however low its ceiling.
    for (const predefinedType of ['PARKING', 'EXTERNAL', 'GFA']) {
      const rule = ruleOf(
        runBimRules([{ ...space('Wohnen', 2.0), predefinedType }]),
        'oib3-raumhoehe'
      )
      expect(rule.passed + rule.failed + rule.undecidable, predefinedType).toBe(0)
    }
  })

  it('fails a low Aufenthaltsraum', () => {
    const rule = ruleOf(runBimRules([space('Wohnen', 2.3)]), 'oib3-raumhoehe')
    expect(rule.failed).toBe(1)
  })

  it('leaves ENGLISH circulation and service rooms out of scope too', () => {
    // Half the Austrian offices running Revit have an English CAD template.
    // A German-only marker list holds `Corridor` to 2,50 m and reports failures
    // nobody has to fix.
    const rule = ruleOf(
      runBimRules([
        space('Corridor', 2.2),
        space('Plant Room', 2.1),
        space('Storage 03', 2.0),
        space('Stair Core', 2.2),
      ]),
      'oib3-raumhoehe'
    )
    expect(rule.passed + rule.failed + rule.undecidable).toBe(0)
  })

  it('still checks an English-named living space', () => {
    const rule = ruleOf(runBimRules([space('Living Room', 2.3)]), 'oib3-raumhoehe')
    expect(rule.failed).toBe(1)
  })

  it('leaves circulation and service rooms out of scope', () => {
    // Holding a Technikraum to 2,50 m produces failures nobody has to fix, and
    // a checker that cries wolf is one nobody reads.
    const rule = ruleOf(
      runBimRules([space('Flur', 2.2), space('Technikraum', 2.1), space('WC', 2.2)]),
      'oib3-raumhoehe'
    )
    expect(rule.passed + rule.failed + rule.undecidable).toBe(0)
  })

  it('will not pass a room on its GROSS height', () => {
    // `Qto_SpaceBaseQuantities.Height` is the structural space height, not the
    // lichte Raumhöhe. Floor build-up and a suspended ceiling take 15–25 cm out
    // of it, so a room publishing 2,65 m gross can finish at 2,42 m. The rule
    // read it as a clear height and ticked the room.
    const gross = element({
      ifcType: 'IfcSpace',
      name: 'Wohnen',
      predefinedType: 'INTERNAL',
      quantities: { Qto_SpaceBaseQuantities: { Height: 2.65 } },
    })
    const rule = ruleOf(runBimRules([gross]), 'oib3-raumhoehe')

    expect(rule.passed).toBe(0)
    expect(rule.undecidable).toBe(1)
    expect(rule.unknowns[0].reading).toContain('Brutto-Raumhöhe')
    expect(rule.missing[0].path).toContain('FinishCeilingHeight')
  })

  it('still settles a FAILURE from the gross height', () => {
    // Same asymmetry as the door: an upper bound cannot earn a tick, but if
    // even the gross height is under 2,50 m the clear height certainly is.
    const gross = element({
      ifcType: 'IfcSpace',
      name: 'Wohnen',
      predefinedType: 'INTERNAL',
      quantities: { Qto_SpaceBaseQuantities: { Height: 2.3 } },
    })
    expect(ruleOf(runBimRules([gross]), 'oib3-raumhoehe').failed).toBe(1)
  })

  it('prefers the clear height when the model publishes both', () => {
    const both = element({
      ifcType: 'IfcSpace',
      name: 'Wohnen',
      predefinedType: 'INTERNAL',
      quantities: { Qto_SpaceBaseQuantities: { Height: 2.9, FinishCeilingHeight: 2.4 } },
    })
    const rule = ruleOf(runBimRules([both]), 'oib3-raumhoehe')

    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('Lichte Raumhöhe')
  })
})

describe('room names are matched by word, not by substring', () => {
  const space = (name: string) =>
    element({
      ifcType: 'IfcSpace',
      name,
      predefinedType: 'INTERNAL',
      quantities: { Qto_SpaceBaseQuantities: { FinishCeilingHeight: 2.3 } },
    })

  it('checks the Aufenthaltsräume a substring match silently dropped', () => {
    // Every one of these produced NO ROW under `name.includes(marker)` — not a
    // pass, not a fail, nothing. An invisible exclusion is worse than a wrong
    // verdict because there is nothing on screen to disagree with.
    const dropped = [
      'Level 2 Storey Plan Office', // 'store' ⊂ 'storey'
      'Upstairs Bedroom', // 'stair' ⊂ 'upstairs'
      'Showcase', // 'wc' ⊂ 'showcase'
      'Implantologie', // 'plant' ⊂ 'implantologie'
      'Badminton-Halle', // 'bad' ⊂ 'badminton'
      'Besprechung Bad Gastein', // meeting rooms named after spa towns
      'Büro Keller', // Keller is also a common Austrian surname
      'Store (Verkauf)', // a Verkaufsraum IS an Aufenthaltsraum
      'Gangküche',
    ]
    for (const name of dropped) {
      expect(ruleOf(runBimRules([space(name)]), 'oib3-raumhoehe').failed, name).toBe(1)
    }
  })

  it('still excludes the rooms the markers are actually for', () => {
    const excluded = [
      'Flur',
      'Gang',
      'WC',
      'WC-Vorraum',
      'Technikraum',
      'TR 01 Stiegenhaus',
      'Treppenhaus',
      'Abstellraum',
      'Installationsschacht',
      'Tiefgarage',
      'Lagerraum',
      'Badezimmer',
      'Corridor',
      'Plant Room',
      'Storage 03',
      'Stair Core',
      'Hallway',
    ]
    for (const name of excluded) {
      const rule = ruleOf(runBimRules([space(name)]), 'oib3-raumhoehe')
      expect(rule.passed + rule.failed + rule.undecidable, name).toBe(0)
    }
  })
})

describe('a reading never contradicts the verdict printed beside it', () => {
  // `round(0.795)` is `0.8`, so the row read
  // `Lichte Durchgangsbreite 0,80 m — Schwellwert ≥ 0,80 m` and then said
  // **nicht erfüllt**. The same arithmetic appeared on the U-value, Raumhöhe
  // and stair rules, and it travels verbatim into the BCF export.
  const door = (clear: number) =>
    element({
      ifcType: 'IfcDoor',
      name: 'T-14',
      quantities: { Qto_DoorBaseQuantities: { ClearWidth: clear } },
    })

  it('widens a width that rounds onto the threshold it fails', () => {
    const rule = ruleOf(runBimRules([door(0.795)]), 'oib4-tuer-durchgangsbreite')

    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('0,795')
    expect(rule.failures[0].reading).not.toContain('0,80 m — Schwellwert')
  })

  it('widens a Raumhöhe that rounds onto its threshold', () => {
    const rule = ruleOf(
      runBimRules([
        element({
          ifcType: 'IfcSpace',
          name: 'Wohnen',
          predefinedType: 'INTERNAL',
          quantities: { Qto_SpaceBaseQuantities: { FinishCeilingHeight: 2.496 } },
        }),
      ]),
      'oib3-raumhoehe'
    )

    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('2,496')
  })

  it('widens a U-value that rounds onto its threshold', () => {
    const rule = ruleOf(
      runBimRules([
        element({
          ifcType: 'IfcWall',
          name: 'AW-01',
          properties: { Pset_WallCommon: { IsExternal: true, ThermalTransmittance: 0.3549 } },
        }),
      ]),
      'oib6-u-wert-aussenwand'
    )

    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('0,355')
  })

  it('widens a stair riser that rounds onto its threshold', () => {
    const rule = ruleOf(
      runBimRules([
        element({
          ifcType: 'IfcStairFlight',
          name: 'ST-1',
          properties: { Pset_StairFlightCommon: { RiserHeight: 0.1804, TreadLength: 0.28 } },
        }),
      ]),
      'oib4-treppe-steigungsverhaeltnis'
    )

    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('h = 18,04')
  })

  it('does not widen an ordinary reading, and never mixes decimal separators', () => {
    // The point is the SHORTEST rendering that supports the verdict — widening
    // everything to four decimals would fix the contradiction and make every
    // other row unreadable.
    const rule = ruleOf(runBimRules([door(0.7)]), 'oib4-tuer-durchgangsbreite')

    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('0,70 m')
    // A German threshold beside a JS-rendered point: `0.7 m — ≥ 0,80 m`.
    expect(rule.failures[0].reading).not.toMatch(/\d\.\d/)
  })
})

describe('applicability', () => {
  it('drops OIB 6 for an unconditioned storage building, with the reason', () => {
    const rule = ruleOf(
      runBimRules([element({ ifcType: 'IfcWindow', name: 'F1' })], { hauptnutzung: 'lager' }),
      'oib6-u-wert-fenster'
    )
    expect(rule.applicable).toBe(false)
    expect(rule.notApplicableReason).toContain('OIB 6')
  })

  it('keeps a rule with no in-scope elements rather than hiding it', () => {
    // "No load-bearing walls were checked" is information. Dropping the row
    // would make an incomplete model look like a short list of clean results.
    const results = runBimRules([], { gebaeudeklasse: 3, hauptnutzung: 'wohnen' })
    expect(results).toHaveLength(BIM_RULES.length)
    expect(summarizeBimRules(results).rulesEmpty).toBeGreaterThan(0)
  })
})

describe('oib5-schalldaemmung-deklariert', () => {
  it('treats an undeclared value as undecidable, never as a breach', () => {
    // A missing AcousticRating is a gap in the model, not proof that the wall
    // fails the Richtlinie.
    const rule = ruleOf(
      runBimRules([element({ ifcType: 'IfcWall', name: 'IW1' })], { hauptnutzung: 'wohnen' }),
      'oib5-schalldaemmung-deklariert'
    )
    expect(rule.undecidable).toBe(1)
    expect(rule.failed).toBe(0)
  })

  const wall = (rating: string | number) =>
    element({
      ifcType: 'IfcWall',
      name: 'IW1',
      properties: { Pset_WallCommon: { AcousticRating: rating } },
    })
  const verdict = (rating: string | number) =>
    ruleOf(runBimRules([wall(rating)], { hauptnutzung: 'wohnen' }), 'oib5-schalldaemmung-deklariert')

  it('refuses prose as a declaration', () => {
    // The bug, and the worst kind this catalogue can have: `numericProperty` is
    // anchored at the START of the string, so it parsed neither `Rw 30 dB` nor
    // `siehe Beilage` — and everything it failed to parse fell through to
    // `pass`. A wall whose rating read "siehe Beilage" was reported ERFÜLLT
    // under an OIB 5 caption.
    for (const prose of ['siehe Beilage', 'keine Anforderung', 'tbd', 'n/a', 'gemäß ÖNORM']) {
      const rule = verdict(prose)
      expect(rule.passed, prose).toBe(0)
      expect(rule.undecidable, prose).toBe(1)
    }
  })

  it('refuses prose that merely CONTAINS a number', () => {
    // The first fix for the bug above recreated it from the other side: taking
    // the first number anywhere in the string read `siehe OIB 5` as 5 dB and
    // `ÖNORM B 8115-2` as 8115 dB, and reported both **erfüllt**. A number
    // counts only when an acoustic label introduces it, `dB` follows it, or it
    // is the entire value.
    for (const prose of [
      'siehe OIB 5',
      'ÖNORM B 8115-2',
      'gemäß ÖNORM B 8115-2',
      'siehe Beiblatt 3',
      'Anforderung laut Bauteilkatalog 2019',
    ]) {
      const rule = verdict(prose)
      expect(rule.passed, prose).toBe(0)
      expect(rule.undecidable, prose).toBe(1)
    }
  })

  it('reads the rating, not the standard number standing in front of it', () => {
    // The realistic authored string: a reference AND the value. Taking the
    // first number would report this wall at 8115 dB.
    expect(verdict('gemäß ÖNORM B 8115-2, Rw 55 dB').passed).toBe(1)
    expect(verdict('ÖNORM B 8115-2 / 55 dB').passed).toBe(1)
  })

  it('accepts a rated value however the exporter labelled it', () => {
    // The other half of the same anchoring bug: these are real declarations and
    // all of them failed to parse.
    for (const rating of ['Rw 53 dB', "R'w = 55 dB", 'DnT,w 52', '52 dB', 52]) {
      const rule = verdict(rating)
      expect(rule.passed, String(rating)).toBe(1)
    }
  })

  it('quotes the string it refused, so the author can find it in the exporter', () => {
    // A verdict of "not decidable" that does not say WHAT it read sends the
    // architect back to the model to guess. Only failures and unknowns carry
    // rows (`VISIBLE_VERDICTS` caps those two), so this is the reading a reader
    // ever actually sees for this rule.
    const rule = verdict('siehe Beilage')
    expect(rule.unknowns[0]?.reading).toContain('siehe Beilage')
    // And the shopping list must ask for a RATED value, not merely the
    // property — the property was already there, holding prose.
    expect(rule.missing.map((entry) => entry.path)).toEqual([
      'Pset_WallCommon.AcousticRating (bewertetes Maß in dB, z. B. „Rw 53 dB“)',
    ])
  })

  it('still refuses the zero an exporter writes for "nothing declared"', () => {
    for (const zero of ['0', 0, '0 dB']) {
      const rule = verdict(zero)
      expect(rule.undecidable, String(zero)).toBe(1)
      expect(rule.unknowns[0]?.reading, String(zero)).toContain('vermutlich nicht gesetzt')
    }
  })
})

describe('missingPropertyShoppingList', () => {
  it('is the to-do list: one property, how many elements, which rules it unblocks', () => {
    const elements = [
      element({ ifcType: 'IfcWall', name: 'W1', properties: { Pset_WallCommon: { LoadBearing: true } } }),
      element({ ifcType: 'IfcWall', name: 'W2', properties: { Pset_WallCommon: { LoadBearing: true } } }),
      element({ ifcType: 'IfcDoor', name: 'D1' }),
    ]
    const list = missingPropertyShoppingList(
      runBimRules(elements, { gebaeudeklasse: 4, hauptnutzung: 'wohnen', storeys: STOREYS })
    )
    const fireRating = list.find((entry) => entry.path.includes('FireRating'))
    expect(fireRating?.elements).toBe(2)
    expect(fireRating?.rules).toContain('oib2-feuerwiderstand-tragend')
    // Ordered by how much is blocked, so the biggest win is first. Comparing
    // only the endpoints caught a full reversal and nothing else — a
    // misplaced middle entry passed, and a one-entry list compared a number
    // with itself.
    const counts = list.map((entry) => entry.elements)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })
})

describe('renderBimRules', () => {
  it('always carries the orientation caveat', () => {
    const rendered = renderBimRules(runBimRules([], { gebaeudeklasse: 2, storeys: STOREYS }))
    expect(rendered).toContain('keine Rechtsauskunft')
    expect(rendered).toContain('Nicht entscheidbar')
  })

  it('states the threshold beside the counts', () => {
    const rendered = renderBimRules(
      runBimRules(
        [element({ ifcType: 'IfcDoor', name: 'D1', quantities: { Qto_DoorBaseQuantities: { Width: 700 } } })],
        {}
      )
    )
    expect(rendered).toContain('1 nicht erfüllt')
    expect(rendered).toContain('≥ 0,80 m')
  })
})

describe('summarizeBimRules', () => {
  it('separates "all passed" from "nothing was decidable" from "nothing to check"', () => {
    const summary = summarizeBimRules(
      runBimRules(
        [
          element({ ifcType: 'IfcDoor', name: 'ok', quantities: { Qto_DoorBaseQuantities: { ClearWidth: 900 } } }),
          element({ ifcType: 'IfcWindow', name: 'unknown' }),
        ],
        { hauptnutzung: 'wohnen' }
      )
    )
    expect(summary.rulesPassing).toBe(1)
    expect(summary.rulesUndecidable).toBe(1)
    expect(summary.rulesEmpty).toBeGreaterThan(0)
    expect(summary.elementsUndecidable).toBe(1)
  })
})


describe('diffBimCompliance', () => {
  const wall = (rating: string | null) =>
    element({
      ifcType: 'IfcWall',
      name: 'W1',
      properties: {
        Pset_WallCommon: { LoadBearing: true, ...(rating === null ? {} : { FireRating: rating }) },
      },
    })
  const facts = { gebaeudeklasse: 5 as const, storeys: STOREYS }
  const runOn = (rating: string | null) => runBimRules([wall(rating)], facts)

  it('names what a revision BROKE, first', () => {
    const changes = diffBimCompliance(runOn('REI 90'), runOn('REI 30'))
    const fire = changes.find((change) => change.ruleId === 'oib2-feuerwiderstand-tragend')
    expect(fire?.trend).toBe('broken')
    expect(changes[0].trend).toBe('broken')
  })

  it('reports a property the revision LOST as no longer decidable', () => {
    // A re-export with a different mapping silently un-checks a requirement
    // that was green yesterday. Comparing only pass↔fail would miss it.
    const changes = diffBimCompliance(runOn('REI 90'), runOn(null))
    expect(changes.find((change) => change.ruleId === 'oib2-feuerwiderstand-tragend')?.trend).toBe(
      'undecidable'
    )
  })

  it('reports a requirement that became decidable and passes', () => {
    const changes = diffBimCompliance(runOn(null), runOn('REI 90'))
    expect(changes.find((change) => change.ruleId === 'oib2-feuerwiderstand-tragend')?.trend).toBe(
      'decidable'
    )
  })

  it('reports a PARTIAL loss of a property, not just a total one', () => {
    // Two compliant walls; the re-export drops FireRating from one of them.
    // The rule used to stand at `pass` with 2 passed and still stood at `pass`
    // with 1 passed + 1 undecidable, so the diff said nothing moved — and
    // "nothing moved" is exactly the answer this op exists to disprove.
    const second = (rating: string | null) =>
      element({
        ifcType: 'IfcWall',
        name: 'W2',
        properties: {
          Pset_WallCommon: { LoadBearing: true, ...(rating === null ? {} : { FireRating: rating }) },
        },
      })
    const before = runBimRules([wall('REI 90'), second('REI 90')], facts)
    const after = runBimRules([wall('REI 90'), second(null)], facts)

    expect(
      diffBimCompliance(before, after).find(
        (change) => change.ruleId === 'oib2-feuerwiderstand-tragend'
      )?.trend
    ).toBe('undecidable')
  })

  it('says nothing about the rules that did not move', () => {
    // A change list that restates everything is a list nobody reads.
    expect(diffBimCompliance(runOn('REI 90'), runOn('REI 90'))).toEqual([])
  })

  it('surfaces a change of scale within the same verdict', () => {
    const before = runBimRules(
      [wall('REI 30'), element({ ifcType: 'IfcWall', name: 'W2', properties: { Pset_WallCommon: { LoadBearing: true, FireRating: 'REI 90' } } })],
      facts
    )
    const after = runBimRules(
      [wall('REI 30'), element({ ifcType: 'IfcWall', name: 'W2', properties: { Pset_WallCommon: { LoadBearing: true, FireRating: 'REI 30' } } })],
      facts
    )
    const fire = diffBimCompliance(before, after).find(
      (change) => change.ruleId === 'oib2-feuerwiderstand-tragend'
    )
    // Still failing, but twice as much — invisible to a pass/fail comparison.
    expect(fire?.trend).toBe('moved')
    expect(fire?.before.failed).toBe(1)
    expect(fire?.after.failed).toBe(2)
  })

  it('renders an empty diff as a sentence, not as nothing', () => {
    expect(renderBimComplianceDiff([])).toContain('Keine Anforderung')
  })

  it('renders the counts beside the trend', () => {
    const rendered = renderBimComplianceDiff(diffBimCompliance(runOn('REI 90'), runOn('REI 30')))
    expect(rendered).toContain('neu nicht erfüllt')
    expect(rendered).toContain('erfüllt/nicht erfüllt/nicht entscheidbar')
  })
})


describe('human confirmations', () => {
  const failing = runBimRules(
    [
      element({
        ifcType: 'IfcDoor',
        name: 'T-14',
        quantities: { Qto_DoorBaseQuantities: { Width: 0.7 } },
      }),
    ],
    {}
  )
  const confirmation = {
    ruleId: 'oib4-tuer-durchgangsbreite',
    modelId: 'rev-3',
    confirmedBy: 'a.muster',
    note: 'Nebenraum, keine Aufenthaltsnutzung — mit der MA 37 abgeklärt.',
    confirmedAt: '2026-03-02T09:00:00.000Z',
  }

  it('sits beside the machine verdict rather than overwriting it', () => {
    // An architect who confirms a failing rule has said "I know, and it is
    // fine". Flipping the status to pass would hide what the model says.
    const [rule] = attachConfirmations(failing, [confirmation], 'rev-3').filter(
      (entry) => entry.ruleId === 'oib4-tuer-durchgangsbreite'
    )
    expect(rule.failed).toBe(1)
    expect(rule.confirmation?.confirmedBy).toBe('a.muster')
    expect(rule.confirmationStale).toBe(false)
  })

  it('marks a confirmation made against another revision as stale', () => {
    // `rev-3` and `rev-4` are two revisions of ONE building, so the series has
    // to name both — a confirmation from outside the building on screen is not
    // attached at all.
    const [rule] = attachConfirmations(failing, [confirmation], 'rev-4', ['rev-3', 'rev-4']).filter(
      (entry) => entry.ruleId === 'oib4-tuer-durchgangsbreite'
    )
    // Still there — a signature is not deleted by a re-export — but no longer
    // covering: it was true of the building that person looked at.
    expect(rule.confirmation).not.toBeNull()
    expect(rule.confirmationStale).toBe(true)
  })

  it('does not show one building’s confirmation on another building’s Prüfbuch', () => {
    // A project holds `Haus-A` and `Nebengebäude` side by side. A signature
    // made on one says nothing whatsoever about the other, and showing it
    // marked "Älterer Stand" asserts that it is an earlier version of the same
    // building — which is a different, and false, claim.
    const [rule] = attachConfirmations(failing, [confirmation], 'nebengebaeude-1', [
      'nebengebaeude-1',
    ]).filter((entry) => entry.ruleId === 'oib4-tuer-durchgangsbreite')
    expect(rule.confirmation).toBeNull()
    expect(rule.confirmationStale).toBe(false)
  })

  it('prefers the current revision’s confirmation over an older one', () => {
    const older = { ...confirmation, modelId: 'rev-3', confirmedBy: 'a.muster' }
    const current = { ...confirmation, modelId: 'rev-4', confirmedBy: 'b.beispiel' }
    const [rule] = attachConfirmations(failing, [older, current], 'rev-4', [
      'rev-3',
      'rev-4',
    ]).filter((entry) => entry.ruleId === 'oib4-tuer-durchgangsbreite')
    expect(rule.confirmation?.confirmedBy).toBe('b.beispiel')
    expect(rule.confirmationStale).toBe(false)
  })

  it('shows the most recent older confirmation when the current revision has none', () => {
    const first = { ...confirmation, modelId: 'rev-2', confirmedAt: '2026-01-01T00:00:00.000Z' }
    const second = { ...confirmation, modelId: 'rev-3', confirmedAt: '2026-03-02T09:00:00.000Z' }
    const [rule] = attachConfirmations(failing, [first, second], 'rev-4', [
      'rev-2',
      'rev-3',
      'rev-4',
    ]).filter((entry) => entry.ruleId === 'oib4-tuer-durchgangsbreite')
    expect(rule.confirmation?.modelId).toBe('rev-3')
    expect(rule.confirmationStale).toBe(true)
  })

  it('leaves a rule with no confirmation alone', () => {
    const rules = attachConfirmations(failing, [], 'rev-3')
    expect(rules.every((rule) => rule.confirmation === null)).toBe(true)
    expect(rules.every((rule) => rule.confirmationStale === false)).toBe(true)
  })
})

describe('outstandingRules', () => {
  const run = runBimRules(
    [
      element({ ifcType: 'IfcDoor', name: 'narrow', quantities: { Qto_DoorBaseQuantities: { Width: 0.7 } } }),
      element({ ifcType: 'IfcWall', name: 'W1', properties: { Pset_WallCommon: { LoadBearing: true } } }),
    ],
    { gebaeudeklasse: 3, storeys: STOREYS }
  )
  const cover = (ruleId: string, modelId: string) => ({
    ruleId,
    modelId,
    confirmedBy: 'a.muster',
    note: null,
    confirmedAt: '2026-03-02T09:00:00.000Z',
  })

  it('lists what still needs a human', () => {
    const outstanding = outstandingRules(attachConfirmations(run, [], 'rev-3'))
    const ids = outstanding.map((rule) => rule.ruleId)
    expect(ids).toContain('oib4-tuer-durchgangsbreite')
    expect(ids).toContain('oib2-feuerwiderstand-tragend')
  })

  it('drops a rule a current confirmation covers', () => {
    const outstanding = outstandingRules(
      attachConfirmations(run, [cover('oib4-tuer-durchgangsbreite', 'rev-3')], 'rev-3')
    )
    expect(outstanding.map((rule) => rule.ruleId)).not.toContain('oib4-tuer-durchgangsbreite')
  })

  it('does NOT let a stale confirmation close a rule', () => {
    // The whole reason staleness is tracked: a signature must not outlive the
    // drawing it was made about.
    const outstanding = outstandingRules(
      attachConfirmations(run, [cover('oib4-tuer-durchgangsbreite', 'rev-2')], 'rev-3')
    )
    expect(outstanding.map((rule) => rule.ruleId)).toContain('oib4-tuer-durchgangsbreite')
  })

  it('never lists a rule that passed or stood down', () => {
    const outstanding = outstandingRules(attachConfirmations(run, [], 'rev-3'))
    // Or the loop below runs zero times and this test asserts nothing — and
    // an empty list is exactly the regression that would silently empty the
    // "still needs a human" list.
    expect(outstanding.length).toBeGreaterThan(0)
    for (const rule of outstanding) {
      expect(rule.applicable).toBe(true)
      expect(rule.failed + rule.undecidable).toBeGreaterThan(0)
    }
  })
})
