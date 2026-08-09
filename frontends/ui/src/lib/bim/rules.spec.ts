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
  const facts = { gebaeudeklasse: 4 as const }

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

  it('still asks REI of a wall', () => {
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

    // R 90 does not cover E and I; a wall separates as well as carries.
    expect(rule.passed).toBe(0)
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
      { gebaeudeklasse: 5 }
    )
    const rule = ruleOf(results, 'oib2-feuerwiderstand-tragend')
    expect(rule.undecidable).toBe(1)
    expect(rule.missing[0].path).toContain('FireRating')
    // The reading still states the requirement, so the row is actionable even
    // before the property exists.
    expect(rule.unknowns[0].reading).toContain('REI 90')
  })
})

describe('units', () => {
  it('reads a door width in millimetres as metres', () => {
    // 900 read as 900 m would clear every threshold ever written.
    const results = runBimRules([
      element({ ifcType: 'IfcDoor', name: 'D1', quantities: { Qto_DoorBaseQuantities: { Width: 900 } } }),
    ])
    const rule = ruleOf(results, 'oib4-tuer-durchgangsbreite')
    expect(rule.passed).toBe(1)
    expect(rule.failures).toHaveLength(0)
  })

  it('reads the same width expressed in metres identically', () => {
    const results = runBimRules([
      element({ ifcType: 'IfcDoor', name: 'D1', quantities: { Qto_DoorBaseQuantities: { Width: 0.9 } } }),
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
    const rule = ruleOf(runBimRules([wall('REI 90')], { gebaeudeklasse: 5 }), 'oib2-feuerwiderstand-tragend')
    expect(rule.passed).toBe(1)
  })

  it('fails a wall that is short of the minutes', () => {
    const rule = ruleOf(runBimRules([wall('REI 30')], { gebaeudeklasse: 5 }), 'oib2-feuerwiderstand-tragend')
    expect(rule.failed).toBe(1)
    expect(rule.failures[0].reading).toContain('erforderlich REI 90')
  })

  it('fails a rating with enough minutes but the wrong criteria', () => {
    // EI 90 is not R 90: the wall is load-bearing and the declaration says
    // nothing about load-bearing behaviour. Comparing 90 >= 90 alone would
    // call this compliant.
    const rule = ruleOf(runBimRules([wall('EI 90')], { gebaeudeklasse: 5 }), 'oib2-feuerwiderstand-tragend')
    expect(rule.failed).toBe(1)
  })

  it('ignores non-load-bearing walls entirely', () => {
    const rule = ruleOf(
      runBimRules([wall(null, false)], { gebaeudeklasse: 5 }),
      'oib2-feuerwiderstand-tragend'
    )
    expect(rule.passed + rule.failed + rule.undecidable).toBe(0)
  })

  it('stands down when the Gebäudeklasse is unknown rather than assuming the mildest', () => {
    // Assuming GK1 would turn a GK5 building's missing R 90 into a pass.
    const rule = ruleOf(runBimRules([wall('R 30')], {}), 'oib2-feuerwiderstand-tragend')
    expect(rule.applicable).toBe(false)
    expect(rule.notApplicableReason).toContain('Gebäudeklasse')
  })

  it('does not cry wolf over the older F-classification', () => {
    // F 90 is the older Austrian/German designation and DOES mean load-bearing
    // 90 minutes. Scoring it against REI 90 on letters would mark a compliant
    // wall as failing, and a checker that raises false alarms on fire ratings
    // is one nobody reads. The value is shown, the verdict is withheld.
    const rule = ruleOf(runBimRules([wall('F 90')], { gebaeudeklasse: 5 }), 'oib2-feuerwiderstand-tragend')
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
        runBimRules([wall(combined)], { gebaeudeklasse: 3 }),
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
      ruleOf(runBimRules([wall('REI 30')], { gebaeudeklasse: 5 }), 'oib2-feuerwiderstand-tragend').failed
    ).toBe(1)
  })

  it('reports an unreadable rating as undecidable, not as a failure', () => {
    const rule = ruleOf(
      runBimRules([wall('feuerhemmend')], { gebaeudeklasse: 3 }),
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
    element({ ifcType: 'IfcDoor', name: 'D1', quantities: { Qto_DoorBaseQuantities: { Width: width } } })

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
})

describe('missingPropertyShoppingList', () => {
  it('is the to-do list: one property, how many elements, which rules it unblocks', () => {
    const elements = [
      element({ ifcType: 'IfcWall', name: 'W1', properties: { Pset_WallCommon: { LoadBearing: true } } }),
      element({ ifcType: 'IfcWall', name: 'W2', properties: { Pset_WallCommon: { LoadBearing: true } } }),
      element({ ifcType: 'IfcDoor', name: 'D1' }),
    ]
    const list = missingPropertyShoppingList(
      runBimRules(elements, { gebaeudeklasse: 4, hauptnutzung: 'wohnen' })
    )
    const fireRating = list.find((entry) => entry.path.includes('FireRating'))
    expect(fireRating?.elements).toBe(2)
    expect(fireRating?.rules).toContain('oib2-feuerwiderstand-tragend')
    // Ordered by how much is blocked, so the biggest win is first.
    expect(list[0].elements).toBeGreaterThanOrEqual(list[list.length - 1].elements)
  })
})

describe('renderBimRules', () => {
  it('always carries the orientation caveat', () => {
    const rendered = renderBimRules(runBimRules([], { gebaeudeklasse: 2 }))
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
          element({ ifcType: 'IfcDoor', name: 'ok', quantities: { Qto_DoorBaseQuantities: { Width: 900 } } }),
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
  const facts = { gebaeudeklasse: 5 as const }
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
    const [rule] = attachConfirmations(failing, [confirmation], 'rev-4').filter(
      (entry) => entry.ruleId === 'oib4-tuer-durchgangsbreite'
    )
    // Still there — a signature is not deleted by a re-export — but no longer
    // covering: it was true of the building that person looked at.
    expect(rule.confirmation).not.toBeNull()
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
    { gebaeudeklasse: 3 }
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
    for (const rule of outstanding) {
      expect(rule.applicable).toBe(true)
      expect(rule.failed + rule.undecidable).toBeGreaterThan(0)
    }
  })
})
