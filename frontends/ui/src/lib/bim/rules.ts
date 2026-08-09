/**
 * The rule catalog — OIB requirements evaluated against the model's own
 * published values.
 *
 * This is the join the product has been missing. One half knows the rules (the
 * OIB corpus, the applicability engine); the other knows the building
 * (`bim_elements`). Until now a person joined them one question at a time and
 * the answer evaporated. Here a requirement becomes an object with a verdict,
 * the elements it was decided on, and the reading it made.
 *
 * ## Three states, and the third is the point
 *
 * `pass` / `fail` / **`undecidable`**. A two-state checker over a model that is
 * 60% property-complete would report a building as compliant because the
 * evidence for non-compliance is missing — the single worst thing this product
 * could do. So an element that publishes nothing is `undecidable`, never
 * `pass`, and every undecidable verdict names the EXACT property that would
 * settle it. That list is not an apology for incomplete coverage; it is the
 * architect's to-do list in Revit, and it is often worth more than the ticks.
 *
 * ## Every verdict shows its work
 *
 * A rule renders the value it read AND the threshold it applied, with the
 * clause: `2h + b = 63 cm — Schwellwert 59–65 cm (OIB 4, Punkt 2.2)`. A tool
 * that asserts "erfüllt" without showing the comparison is asking to be
 * trusted; one that shows both is asking to be checked, which is the only
 * defensible posture for output that ends up in an Einreichung.
 *
 * ## What is deliberately absent
 *
 * Every rule here reads a PUBLISHED property or quantity. Nothing reads
 * geometry, because the server holds none — no coordinates, no solids, no
 * opening graph, no space boundaries. Fluchtweglängen, Geländerhöhen,
 * Brandabschnittsgrößen and Belichtung per room are therefore not in this
 * catalog and must not be approximated into it. Six rules that are right beat
 * twelve with one that is wrong.
 *
 * Orientation, not legal advice — the same framing the applicability engine
 * carries (`src/aiq_agent/common/applicability.py`).
 *
 * Pure: a function of element records plus the project facts.
 */

import type { BimElement } from './types'

export type BimCheckStatus = 'pass' | 'fail' | 'undecidable'

/** The project facts a rule's applicability may depend on. */
export interface BimRuleFacts {
  /** `1` … `5`, as the intake vocabulary records it. */
  gebaeudeklasse?: number | null
  /** Intake use token: `wohnen`, `buero`, `beherbergung`, … */
  hauptnutzung?: string | null
}

/** One element's verdict under one rule. */
export interface BimElementVerdict {
  globalId: string
  name: string | null
  storeyName: string | null
  status: BimCheckStatus
  /**
   * What was read and what it was compared against, as a sentence the
   * architect can check. Present for every state, including `undecidable`.
   */
  reading: string
}

/** For an undecidable element: the property that would settle it. */
export interface BimMissingProperty {
  /** `Pset_WallCommon.FireRating` — the exact path to author in the CAD. */
  path: string
  elements: number
}

export interface BimRuleResult {
  ruleId: string
  richtlinie: string
  clause: string
  titleDe: string
  /** The threshold sentence, independent of any element. */
  thresholdDe: string
  /** `false` when the project facts put this rule out of scope. */
  applicable: boolean
  /** Why it is out of scope, when it is. */
  notApplicableReason?: string
  passed: number
  failed: number
  undecidable: number
  /** Failing elements, capped — the rest are counted, never dropped silently. */
  failures: BimElementVerdict[]
  /** Undecidable elements, capped the same way. */
  unknowns: BimElementVerdict[]
  /** True when `failures`/`unknowns` were capped. */
  truncated: boolean
  /** What to author in the CAD to make the undecidable elements decidable. */
  missing: BimMissingProperty[]
}

/** Rows carried per rule before the count speaks for the rest. */
const VISIBLE_VERDICTS = 25

// ---------------------------------------------------------------------------
// Reading published values
// ---------------------------------------------------------------------------

/** First numeric value found at any of the named quantity keys. */
function quantity(element: BimElement, keys: readonly string[]): number | null {
  for (const set of Object.values(element.quantities)) {
    for (const key of keys) {
      const value = set[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  }
  return null
}

/** First value found at any of the named property keys, across all sets. */
function property(
  element: BimElement,
  keys: readonly string[]
): string | number | boolean | null {
  for (const set of Object.values(element.properties)) {
    for (const key of keys) {
      const value = set[key]
      if (value !== undefined && value !== null && value !== '') return value
    }
  }
  return null
}

/** A numeric property, tolerating the string a CAD sometimes writes. */
function numericProperty(element: BimElement, keys: readonly string[]): number | null {
  const raw = property(element, keys)
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Number(raw.replace(',', '.').replace(/[^0-9.eE+-]/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Millimetres or metres?
 *
 * IFC length values arrive in the model's own unit, and the two conventions in
 * the wild differ by a factor of a thousand. A door "width" of 900 is 0.9 m and
 * one of 0.9 is also 0.9 m — reading the first as 900 m would pass every
 * conceivable threshold, which is precisely the silent-wrong-answer this whole
 * subsystem exists to avoid. Values above 20 are treated as millimetres, which
 * is unambiguous for every dimension this catalog reads (door widths, riser
 * heights, room heights: none is legitimately 20 m or more, and none is
 * legitimately 20 mm or less).
 */
function toMetres(value: number | null): number | null {
  if (value === null) return null
  return value > 20 ? value / 1000 : value
}

/** Same disambiguation for centimetre-scale stair dimensions. */
function toCentimetres(value: number | null): number | null {
  const metres = toMetres(value)
  return metres === null ? null : metres * 100
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// ---------------------------------------------------------------------------
// Fire ratings
// ---------------------------------------------------------------------------

/**
 * `REI 90` / `R60` / `EI30` → 90, 60, 30.
 *
 * The letters say WHICH performance (R load-bearing, E integrity, I insulation)
 * and the number says for how many minutes. Only the minutes are compared here,
 * and only for elements the rule already selected as load-bearing — comparing
 * `EI30` against a required `REI90` on the number alone would be wrong about
 * the letters, which is why the rule reports the raw string in its reading and
 * a mismatch of letters is never silently rounded into a pass.
 */
function fireResistanceMinutes(raw: string): number | null {
  const match = /(\d{2,3})/.exec(raw)
  if (!match) return null
  const minutes = Number(match[1])
  return Number.isFinite(minutes) ? minutes : null
}

/** Does the declared rating carry every letter the requirement asks for? */
function coversCriteria(declared: string, required: string): boolean {
  const letters = /^[A-Za-z]+/.exec(required.trim())?.[0]?.toUpperCase() ?? ''
  const declaredLetters = /^[A-Za-z]+/.exec(declared.trim())?.[0]?.toUpperCase() ?? ''
  return [...letters].every((letter) => declaredLetters.includes(letter))
}

/**
 * Minimum fire resistance for load-bearing components by Gebäudeklasse.
 *
 * Rendered in every verdict alongside the value read, so the threshold itself
 * is reviewable rather than buried. Where the class is unknown the rule reports
 * `undecidable` rather than assuming the mildest class — assuming GK1 would
 * turn a GK5 building's missing R90 into a pass.
 */
const FIRE_RESISTANCE_BY_CLASS: Record<number, string> = {
  1: 'R 30',
  2: 'REI 30',
  3: 'REI 60',
  4: 'REI 60',
  5: 'REI 90',
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

interface RuleDefinition {
  id: string
  richtlinie: string
  clause: string
  titleDe: string
  thresholdDe: string
  /** IFC types this rule judges. */
  ifcTypes: string[]
  /** Narrow further — load-bearing only, external only, … */
  scope?: (element: BimElement) => boolean
  /** Out of scope for this project? Return the reason. */
  notApplicable?: (facts: BimRuleFacts) => string | null
  /** Judge one in-scope element. */
  judge: (
    element: BimElement,
    facts: BimRuleFacts
  ) => { status: BimCheckStatus; reading: string; missing?: string }
}

const isLoadBearing = (element: BimElement): boolean =>
  property(element, ['LoadBearing']) === true

const isExternal = (element: BimElement): boolean => property(element, ['IsExternal']) === true

/** An Aufenthaltsraum, as far as the model lets us tell. */
const isOccupiedSpace = (element: BimElement): boolean => {
  const predefined = (element.predefinedType ?? '').toUpperCase()
  if (predefined && predefined !== 'INTERNAL' && predefined !== 'USERDEFINED') return false
  const name = (element.name ?? '').toLowerCase()
  // Circulation and service rooms are not Aufenthaltsräume, and holding them to
  // the 2.50 m clear height would produce failures nobody has to fix.
  return !['flur', 'gang', 'stiege', 'treppe', 'technik', 'schacht', 'abstell', 'wc', 'bad'].some(
    (marker) => name.includes(marker)
  )
}

export const BIM_RULES: RuleDefinition[] = [
  {
    id: 'oib4-treppe-steigungsverhaeltnis',
    richtlinie: 'OIB 4',
    clause: '2.2',
    titleDe: 'Treppen — Steigungsverhältnis',
    thresholdDe: '2 × Steigung + Auftritt = 59–65 cm, Steigung ≤ 18 cm, Auftritt ≥ 28 cm',
    ifcTypes: ['IfcStairFlight'],
    judge: (element) => {
      const riser = toCentimetres(
        numericProperty(element, ['RiserHeight']) ?? quantity(element, ['RiserHeight'])
      )
      const tread = toCentimetres(
        numericProperty(element, ['TreadLength']) ?? quantity(element, ['TreadLength'])
      )
      if (riser === null || tread === null) {
        return {
          status: 'undecidable',
          reading:
            'Steigung oder Auftritt nicht im Modell veröffentlicht — Steigungsverhältnis nicht berechenbar',
          missing: 'IfcStairFlight.RiserHeight / TreadLength',
        }
      }
      const ratio = round(2 * riser + tread, 1)
      const ok = ratio >= 59 && ratio <= 65 && riser <= 18 && tread >= 28
      return {
        status: ok ? 'pass' : 'fail',
        reading:
          `2h + b = ${ratio} cm (h = ${round(riser, 1)} cm, b = ${round(tread, 1)} cm) — ` +
          'Schwellwert 59–65 cm, h ≤ 18 cm, b ≥ 28 cm',
      }
    },
  },
  {
    id: 'oib4-tuer-durchgangsbreite',
    richtlinie: 'OIB 4',
    clause: '3',
    titleDe: 'Türen — lichte Durchgangsbreite',
    thresholdDe: 'lichte Durchgangsbreite ≥ 0,80 m',
    ifcTypes: ['IfcDoor'],
    judge: (element) => {
      const width = toMetres(
        quantity(element, ['Width', 'ClearWidth']) ??
          numericProperty(element, ['OverallWidth', 'ClearWidth'])
      )
      if (width === null) {
        return {
          status: 'undecidable',
          reading: 'Keine Breite im Modell veröffentlicht',
          missing: 'Qto_DoorBaseQuantities.Width',
        }
      }
      return {
        status: width >= 0.8 ? 'pass' : 'fail',
        reading: `Breite ${round(width)} m — Schwellwert ≥ 0,80 m`,
      }
    },
  },
  {
    id: 'oib3-raumhoehe',
    richtlinie: 'OIB 3',
    clause: '2',
    titleDe: 'Aufenthaltsräume — lichte Raumhöhe',
    thresholdDe: 'lichte Raumhöhe ≥ 2,50 m',
    ifcTypes: ['IfcSpace'],
    scope: isOccupiedSpace,
    judge: (element) => {
      const height = toMetres(
        quantity(element, ['FinishCeilingHeight', 'Height', 'ClearHeight']) ??
          numericProperty(element, ['FinishCeilingHeight', 'Height'])
      )
      if (height === null) {
        return {
          status: 'undecidable',
          reading: 'Keine Raumhöhe im Modell veröffentlicht',
          missing: 'Qto_SpaceBaseQuantities.FinishCeilingHeight',
        }
      }
      return {
        status: height >= 2.5 ? 'pass' : 'fail',
        reading: `Raumhöhe ${round(height)} m — Schwellwert ≥ 2,50 m`,
      }
    },
  },
  {
    id: 'oib2-feuerwiderstand-tragend',
    richtlinie: 'OIB 2',
    clause: '3',
    titleDe: 'Tragende Bauteile — Feuerwiderstand',
    thresholdDe: 'Feuerwiderstand nach Gebäudeklasse (GK1 R 30 … GK5 REI 90)',
    ifcTypes: ['IfcWall', 'IfcWallStandardCase', 'IfcColumn', 'IfcBeam', 'IfcSlab'],
    scope: isLoadBearing,
    notApplicable: (facts) =>
      facts.gebaeudeklasse === undefined || facts.gebaeudeklasse === null
        ? 'Gebäudeklasse in den Projektangaben nicht gesetzt — die Anforderung hängt daran'
        : null,
    judge: (element, facts) => {
      const required = FIRE_RESISTANCE_BY_CLASS[facts.gebaeudeklasse ?? 0]
      // Guarded by notApplicable, but a rule must never read a threshold it
      // does not have: assuming the mildest class would turn a GK5 building's
      // missing R 90 into a pass.
      if (!required) {
        return {
          status: 'undecidable',
          reading: 'Gebäudeklasse unbekannt — erforderlicher Feuerwiderstand nicht bestimmbar',
          missing: 'Projektangabe: Gebäudeklasse',
        }
      }
      const declared = property(element, ['FireRating'])
      if (typeof declared !== 'string' || declared.trim() === '') {
        return {
          status: 'undecidable',
          reading: `Kein Feuerwiderstand am Bauteil hinterlegt — erforderlich ${required}`,
          missing: 'Pset_WallCommon.FireRating (bzw. Pset_*Common.FireRating)',
        }
      }
      const declaredMinutes = fireResistanceMinutes(declared)
      const requiredMinutes = fireResistanceMinutes(required)
      if (declaredMinutes === null || requiredMinutes === null) {
        return {
          status: 'undecidable',
          reading: `Feuerwiderstand „${declared}“ nicht als Klassifizierung lesbar — erforderlich ${required}`,
          missing: 'Pset_WallCommon.FireRating in der Form „REI 90“',
        }
      }
      // Both the minutes AND the letters must hold: EI 90 on a load-bearing
      // wall is not R 90, and comparing only the number would call it one.
      const ok = declaredMinutes >= requiredMinutes && coversCriteria(declared, required)
      return {
        status: ok ? 'pass' : 'fail',
        reading: `Feuerwiderstand ${declared} — erforderlich ${required} (Gebäudeklasse ${facts.gebaeudeklasse})`,
      }
    },
  },
  {
    id: 'oib6-u-wert-aussenwand',
    richtlinie: 'OIB 6',
    clause: '4.1',
    titleDe: 'Außenwände — Wärmedurchgangskoeffizient',
    thresholdDe: 'U ≤ 0,35 W/m²K',
    ifcTypes: ['IfcWall', 'IfcWallStandardCase'],
    scope: isExternal,
    notApplicable: (facts) =>
      facts.hauptnutzung === 'lager' || facts.hauptnutzung === 'landwirtschaft'
        ? 'OIB 6 gilt für unkonditionierte Lager-/landwirtschaftliche Gebäude nicht ohne Weiteres'
        : null,
    judge: (element) => {
      const uValue = numericProperty(element, ['ThermalTransmittance'])
      if (uValue === null) {
        return {
          status: 'undecidable',
          reading: 'Kein U-Wert am Bauteil hinterlegt',
          missing: 'Pset_WallCommon.ThermalTransmittance',
        }
      }
      return {
        status: uValue <= 0.35 ? 'pass' : 'fail',
        reading: `U = ${round(uValue)} W/m²K — Schwellwert ≤ 0,35 W/m²K`,
      }
    },
  },
  {
    id: 'oib6-u-wert-fenster',
    richtlinie: 'OIB 6',
    clause: '4.1',
    titleDe: 'Fenster — Wärmedurchgangskoeffizient',
    thresholdDe: 'U ≤ 1,40 W/m²K',
    ifcTypes: ['IfcWindow'],
    notApplicable: (facts) =>
      facts.hauptnutzung === 'lager' || facts.hauptnutzung === 'landwirtschaft'
        ? 'OIB 6 gilt für unkonditionierte Lager-/landwirtschaftliche Gebäude nicht ohne Weiteres'
        : null,
    judge: (element) => {
      const uValue = numericProperty(element, ['ThermalTransmittance'])
      if (uValue === null) {
        return {
          status: 'undecidable',
          reading: 'Kein U-Wert am Fenster hinterlegt',
          missing: 'Pset_WindowCommon.ThermalTransmittance',
        }
      }
      return {
        status: uValue <= 1.4 ? 'pass' : 'fail',
        reading: `U = ${round(uValue)} W/m²K — Schwellwert ≤ 1,40 W/m²K`,
      }
    },
  },
  {
    id: 'oib5-schalldaemmung-deklariert',
    richtlinie: 'OIB 5',
    clause: '3',
    titleDe: 'Trennbauteile — Schalldämmung deklariert',
    thresholdDe: 'bewertetes Schalldämm-Maß am Bauteil hinterlegt',
    ifcTypes: ['IfcWall', 'IfcWallStandardCase', 'IfcSlab'],
    // Only the separating components, which in a property-only model means the
    // internal ones — an external wall's Schallschutz is a different clause.
    scope: (element) => !isExternal(element),
    notApplicable: (facts) =>
      facts.hauptnutzung && !['wohnen', 'beherbergung', 'gesundheit', 'buero', 'versammlung'].includes(facts.hauptnutzung)
        ? 'OIB 5 ist für diese Nutzung nicht lärmempfindlich einschlägig'
        : null,
    judge: (element) => {
      const rating = property(element, ['AcousticRating'])
      if (rating === null || String(rating).trim() === '') {
        return {
          status: 'undecidable',
          // Deliberately not a `fail`: an undeclared value is a gap in the
          // model, not a proven breach of the Richtlinie.
          reading: 'Kein bewertetes Schalldämm-Maß am Bauteil hinterlegt',
          missing: 'Pset_WallCommon.AcousticRating',
        }
      }
      return { status: 'pass', reading: `Schalldämm-Maß ${String(rating)} hinterlegt` }
    },
  },
]

// ---------------------------------------------------------------------------
// Running the catalog
// ---------------------------------------------------------------------------

const matchesType = (element: BimElement, types: readonly string[]): boolean =>
  types.some((type) => type.toLowerCase() === element.ifcType.toLowerCase())

/**
 * Evaluate every rule over the element set.
 *
 * A rule with no in-scope elements is still returned, with all counts zero —
 * "no load-bearing walls were checked" is information, and dropping the row
 * would make an incomplete model look like a short list of clean results.
 */
export function runBimRules(
  elements: readonly BimElement[],
  facts: BimRuleFacts = {}
): BimRuleResult[] {
  return BIM_RULES.map((rule) => {
    const notApplicableReason = rule.notApplicable?.(facts) ?? null
    const base = {
      ruleId: rule.id,
      richtlinie: rule.richtlinie,
      clause: rule.clause,
      titleDe: rule.titleDe,
      thresholdDe: rule.thresholdDe,
      passed: 0,
      failed: 0,
      undecidable: 0,
      failures: [] as BimElementVerdict[],
      unknowns: [] as BimElementVerdict[],
      truncated: false,
      missing: [] as BimMissingProperty[],
    }
    if (notApplicableReason) {
      return { ...base, applicable: false, notApplicableReason }
    }

    const scoped = elements.filter(
      (element) => matchesType(element, rule.ifcTypes) && (rule.scope?.(element) ?? true)
    )

    const failures: BimElementVerdict[] = []
    const unknowns: BimElementVerdict[] = []
    const missing = new Map<string, number>()
    let passed = 0
    let failed = 0
    let undecidable = 0
    let truncated = false

    for (const element of scoped) {
      const { status, reading, missing: missingPath } = rule.judge(element, facts)
      const verdict: BimElementVerdict = {
        globalId: element.globalId,
        name: element.name,
        storeyName: element.storeyName,
        status,
        reading,
      }
      if (status === 'pass') {
        passed += 1
        continue
      }
      if (status === 'fail') {
        failed += 1
        if (failures.length < VISIBLE_VERDICTS) failures.push(verdict)
        else truncated = true
        continue
      }
      undecidable += 1
      if (unknowns.length < VISIBLE_VERDICTS) unknowns.push(verdict)
      else truncated = true
      if (missingPath) missing.set(missingPath, (missing.get(missingPath) ?? 0) + 1)
    }

    return {
      ...base,
      applicable: true,
      passed,
      failed,
      undecidable,
      failures,
      unknowns,
      truncated,
      missing: [...missing.entries()]
        .map(([path, count]) => ({ path, elements: count }))
        .sort((a, b) => b.elements - a.elements || a.path.localeCompare(b.path)),
    }
  })
}

/** The building-wide totals, for a badge that does not need the whole list. */
export interface BimComplianceSummary {
  rulesApplicable: number
  rulesNotApplicable: number
  /** Rules with at least one failing element. */
  rulesFailing: number
  /** Rules that could not be decided for any in-scope element. */
  rulesUndecidable: number
  /** Rules with in-scope elements, all of which passed. */
  rulesPassing: number
  /** Rules whose element set was empty — nothing to check. */
  rulesEmpty: number
  elementsFailed: number
  elementsUndecidable: number
}

export function summarizeBimRules(results: readonly BimRuleResult[]): BimComplianceSummary {
  const summary: BimComplianceSummary = {
    rulesApplicable: 0,
    rulesNotApplicable: 0,
    rulesFailing: 0,
    rulesUndecidable: 0,
    rulesPassing: 0,
    rulesEmpty: 0,
    elementsFailed: 0,
    elementsUndecidable: 0,
  }
  for (const result of results) {
    if (!result.applicable) {
      summary.rulesNotApplicable += 1
      continue
    }
    summary.rulesApplicable += 1
    summary.elementsFailed += result.failed
    summary.elementsUndecidable += result.undecidable
    const checked = result.passed + result.failed + result.undecidable
    if (checked === 0) summary.rulesEmpty += 1
    else if (result.failed > 0) summary.rulesFailing += 1
    else if (result.passed === 0) summary.rulesUndecidable += 1
    else summary.rulesPassing += 1
  }
  return summary
}

/**
 * What to author in the CAD, across every rule, most-blocking first.
 *
 * The single most useful output of the whole catalog: not "your model scores
 * 74", but "add `Pset_WallCommon.FireRating` to 34 walls and six requirements
 * become decidable".
 */
export function missingPropertyShoppingList(
  results: readonly BimRuleResult[]
): Array<{ path: string; elements: number; rules: string[] }> {
  const byPath = new Map<string, { elements: number; rules: Set<string> }>()
  for (const result of results) {
    if (!result.applicable) continue
    for (const entry of result.missing) {
      const bucket = byPath.get(entry.path) ?? { elements: 0, rules: new Set<string>() }
      bucket.elements += entry.elements
      bucket.rules.add(result.ruleId)
      byPath.set(entry.path, bucket)
    }
  }
  return [...byPath.entries()]
    .map(([path, bucket]) => ({ path, elements: bucket.elements, rules: [...bucket.rules].sort() }))
    .sort((a, b) => b.elements - a.elements || a.path.localeCompare(b.path))
}

/** German one-liner per rule, for the agent to quote without doing arithmetic. */
export function renderBimRules(results: readonly BimRuleResult[]): string {
  const lines = results.map((result) => {
    const head = `${result.richtlinie} ${result.clause} — ${result.titleDe}`
    if (!result.applicable) return `${head}: nicht einschlägig (${result.notApplicableReason})`
    const checked = result.passed + result.failed + result.undecidable
    if (checked === 0) return `${head}: keine betroffenen Bauteile im Modell`
    return (
      `${head}: ${result.passed} erfüllt, ${result.failed} nicht erfüllt, ` +
      `${result.undecidable} nicht entscheidbar (${result.thresholdDe})`
    )
  })
  lines.push(
    'Orientierende Prüfung anhand der im Modell veröffentlichten Werte — keine Rechtsauskunft ' +
      'und kein Nachweis. „Nicht entscheidbar“ heißt: das Modell führt den Wert nicht.'
  )
  return lines.join('\n')
}
