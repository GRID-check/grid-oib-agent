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
  /**
   * The model's storeys with their elevations, from `summary.storeys`.
   *
   * OIB 2 Tabelle 1b asks a different fire-resistance duration of a basement
   * wall than of a ground-floor one, and a third of a top-floor one. Without
   * this list a rule cannot tell them apart, and every basement wall in the
   * country was being judged against the above-ground row.
   */
  storeys?: Array<{ name: string; elevation: number | null }>
  /**
   * Metres per model length unit, from `summary.units.length.siScale`
   * (millimetres → 0.001).
   *
   * The model DECLARES this, so a rule that guesses is a rule that can be
   * wrong. Passed in rather than sniffed because the declaration lives in the
   * summary and the rules only ever see elements.
   */
  lengthScale?: number | null
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

/**
 * A numeric property, tolerating the string a CAD sometimes writes.
 *
 * Reads the LEADING number and stops. The obvious implementation — strip every
 * non-numeric character and parse what is left — silently concatenates digits
 * that were never part of the value: `0,35 W/m2K` becomes `0.352`, which fails
 * a `≤ 0,35` check and reports a compliant wall as non-compliant. (The pretty
 * `m²` escapes because U+00B2 is not an ASCII digit; the plain `m2` a CAD
 * writes just as often does not.) A checker whose answer depends on how the
 * exporter spelled a unit is not a checker.
 *
 * Anything that does not START with a number is refused rather than mined for
 * digits, so `Klasse 2 gemäß ÖNORM` yields nothing instead of `2`.
 */
const LEADING_NUMBER = /^[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?/

function numericProperty(element: BimElement, keys: readonly string[]): number | null {
  const raw = property(element, keys)
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string') return null
  const match = LEADING_NUMBER.exec(raw.trim())
  if (!match) return null
  const parsed = Number(match[0].replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * A model length, in metres.
 *
 * IFC length values arrive in the model's own unit, and the conventions in the
 * wild differ by a factor of a thousand. A door "width" of 900 is 0.9 m and one
 * of 0.9 is also 0.9 m — reading the first as 900 m would clear every
 * threshold ever written, which is precisely the silent-wrong-answer this whole
 * subsystem exists to avoid.
 *
 * The model DECLARES its unit (`IfcUnitAssignment` → `summary.units.length`),
 * so the declaration is authoritative and is used whenever it is present. The
 * magnitude guess below is the fallback for a model that declares nothing, and
 * only that: it is unambiguous for every dimension this catalog reads (door
 * widths, riser heights, room heights — none is legitimately 20 m or more, and
 * none is legitimately 20 mm or less), but it is still a guess, and a guess
 * loses to a declaration every time.
 */
function toMetres(value: number | null, scale?: number | null): number | null {
  if (value === null) return null
  if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) return value * scale
  return value > 20 ? value / 1000 : value
}

/** Same conversion, expressed in centimetres for stair dimensions. */
function toCentimetres(value: number | null, scale?: number | null): number | null {
  const metres = toMetres(value, scale)
  return metres === null ? null : metres * 100
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Decimals in a number's shortest form, so `decimal` never pads noise on. */
function decimalsOf(value: number): number {
  const text = String(value)
  if (text.includes('e')) return 0
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

/**
 * German decimal notation. Every threshold in this catalogue is written the
 * Austrian way — `≥ 0,80 m`, `≤ 0,35 W/m²K` — while the readings beside them
 * came from `String(number)` and used a point. One row said
 * `Breite 0.7 m — Schwellwert ≥ 0,80 m`, mixing both in eleven characters.
 */
function decimal(value: number, minDigits: number): string {
  return value.toFixed(Math.max(minDigits, decimalsOf(value))).replace('.', ',')
}

/**
 * Renders a measurement so the number a reader sees supports the verdict
 * printed beside it.
 *
 * `round(0.795)` is `0.8`, so a door five millimetres under the threshold
 * rendered as `Lichte Durchgangsbreite 0,80 m — Schwellwert ≥ 0,80 m` and then
 * said **nicht erfüllt**: a row contradicting its own arithmetic, in the German
 * the BCF export ships to the Bauzeichner. The same reading appeared on the
 * U-value, Raumhöhe and stair rules.
 *
 * Widening every reading to four decimals would fix it and make every other row
 * unreadable — `2,4999999 m` is noise, not precision. So the SHORTEST rendering
 * is chosen that still lands on the same side of the threshold as the raw
 * measurement. `satisfies` is the rule's own comparison, passed in rather than
 * restated, so the two cannot drift apart.
 */
function measure(
  value: number,
  satisfies: (candidate: number) => boolean,
  digits = 2,
  maxDigits = 5
): string {
  const truth = satisfies(value)
  for (let d = digits; d < maxDigits; d += 1) {
    if (satisfies(round(value, d)) === truth) return decimal(round(value, d), digits)
  }
  return decimal(round(value, maxDigits), digits)
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

/** The European criteria letters, the only system this catalog can compare. */
const EURO_CRITERIA = new Set(['R', 'E', 'I', 'M', 'W', 'S', 'C'])

/**
 * Compare a declared rating against a required one.
 *
 * `meets` / `short` / **`unreadable`** — and the third exists because letters
 * are not interchangeable. `EI 90` on a load-bearing wall is not `R 90`:
 * comparing minutes alone would call it compliant, so the letters are checked
 * too.
 *
 * But the converse trap is just as real. `F 90` is the older Austrian and
 * German designation and does mean load-bearing 90 minutes; scoring it against
 * `REI 90` on letters would mark a compliant wall as FAILING. A false alarm on
 * a fire rating costs an architect an afternoon proving the tool wrong, and a
 * checker that cries wolf is one nobody reads. So a designation outside the
 * European letter system is reported as unreadable — the value is shown, the
 * verdict is withheld, and the person decides.
 */
function compareFireRating(declared: string, required: string): 'meets' | 'short' | 'unreadable' {
  // A combined declaration — `REI 90/EI 30`, `R 30 / EI 90` — carries two
  // performances for two situations, and `fireResistanceMinutes` would take
  // whichever number came first. Picking one at random is how a checker reports
  // `R 30 / EI 90` as failing REI 90 while the wall is fine, or the reverse.
  if (/[/|]|\bund\b|\band\b/i.test(declared)) return 'unreadable'

  const declaredMinutes = fireResistanceMinutes(declared)
  const requiredMinutes = fireResistanceMinutes(required)
  if (declaredMinutes === null || requiredMinutes === null) return 'unreadable'

  const requiredLetters = /^[A-Za-z]+/.exec(required.trim())?.[0]?.toUpperCase() ?? ''
  const declaredLetters = /^[A-Za-z]+/.exec(declared.trim())?.[0]?.toUpperCase() ?? ''
  // A declaration in a different letter system (F 90, T 30, …) is not
  // comparable here, however plainly a human could read it.
  if (declaredLetters === '' || [...declaredLetters].some((letter) => !EURO_CRITERIA.has(letter))) {
    return 'unreadable'
  }
  const coversCriteria = [...requiredLetters].every((letter) => declaredLetters.includes(letter))
  return declaredMinutes >= requiredMinutes && coversCriteria ? 'meets' : 'short'
}

/**
 * Minimum fire resistance for load-bearing components by Gebäudeklasse.
 *
 * Rendered in every verdict alongside the value read, so the threshold itself
 * is reviewable rather than buried. Where the class is unknown the rule reports
 * `undecidable` rather than assuming the mildest class — assuming GK1 would
 * turn a GK5 building's missing R90 into a pass.
 */
/**
 * OIB-Richtlinie 2 (Ausgabe Mai 2023), Tabelle 1b, ROW 1 — "tragende Bauteile
 * (ausgenommen Decken und brandabschnittsbildende Wände)".
 *
 * Two things the earlier version of this file got wrong, both visible the
 * moment the actual table is read:
 *
 * 1. **Row 1 asks for R, never REI** — for load-bearing WALLS as much as for
 *    columns. `REI` appears in rows 2 (Trennwände) and 3
 *    (brandabschnittsbildende Wände), which are different requirements about
 *    different components. Demanding REI of a load-bearing wall reported a
 *    correctly declared `R 90` as nicht erfüllt.
 * 2. **Decken are row 4, not row 1** — the row title excludes them
 *    explicitly, so `IfcSlab` does not belong in this rule at all.
 *
 * Minutes by Gebäudeklasse and storey position. GK5 splits by `> 6
 * oberirdische Geschoße`, which only changes the accompanying A2 material
 * requirement and not the duration, and A2 is not something a FireRating
 * string can settle — so the duration is the same either way.
 */
const FIRE_RESISTANCE_R_MINUTES: Record<'top' | 'above' | 'below', Record<number, number | null>> = {
  // 1.1 im obersten Geschoß — GK1 carries no requirement at all.
  top: { 1: null, 2: 30, 3: 30, 4: 30, 5: 60 },
  // 1.2 in sonstigen oberirdischen Geschoßen.
  above: { 1: 30, 2: 30, 3: 60, 4: 60, 5: 90 },
  // 1.3 in unterirdischen Geschoßen — the row that was missing entirely, and
  // the one where a Kellergeschoß wall was being passed at the above-ground
  // threshold. GK3 upward it doubles.
  below: { 1: 60, 2: 60, 3: 90, 4: 90, 5: 90 },
}

/** Where a storey sits, which decides which row of Tabelle 1b applies. */
export type BimStoreyPosition = 'top' | 'above' | 'below'

const STOREY_LABEL: Record<BimStoreyPosition, string> = {
  top: 'oberstes Geschoß',
  above: 'oberirdisches Geschoß',
  below: 'Kellergeschoß',
}

/**
 * Classify the storey an element sits on.
 *
 * Returns `null` when the model does not say — no storey name on the element,
 * no matching storey in the summary, or a storey with no published elevation.
 * The judge then reports `undecidable` rather than picking a row: the
 * above-ground row would pass a Kellergeschoß wall that needs twice the
 * duration, and the top-storey row would fail a top-floor wall that is
 * correct. Neither guess is safe, and "the model does not say which storey
 * this is" is exactly what the third state is for.
 */
export function classifyStorey(
  storeyName: string | null,
  storeys: BimRuleFacts['storeys']
): BimStoreyPosition | null {
  if (!storeyName || !storeys || storeys.length === 0) return null
  const known = storeys.filter((entry) => typeof entry.elevation === 'number')
  const match = known.find((entry) => entry.name === storeyName)
  if (!match || typeof match.elevation !== 'number') return null
  if (match.elevation < 0) return 'below'
  const highest = Math.max(...known.map((entry) => entry.elevation as number))
  return match.elevation === highest ? 'top' : 'above'
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

/**
 * Could this element be load-bearing?
 *
 * Scope is deliberately WIDER than `LoadBearing === true`. An element that
 * never published the property is not "not load-bearing" — it is unknown, and
 * the previous predicate dropped it out of the rule's scope entirely, so a
 * wall with no `LoadBearing` simply vanished from a fire-resistance check
 * instead of showing up as something nobody had established. The judge then
 * settles it: `true` gets judged, missing becomes `undecidable`.
 */
const mayBeLoadBearing = (element: BimElement): boolean =>
  property(element, ['LoadBearing']) !== false

const isExternal = (element: BimElement): boolean => property(element, ['IsExternal']) === true

/**
 * Room names that mark circulation or service space rather than an
 * Aufenthaltsraum.
 *
 * German AND English, because the room names in an IFC follow whoever set up
 * the CAD template and half the Austrian offices running Revit have an English
 * one. A German-only list holds `Corridor` and `Technical Room` to the 2,50 m
 * clear height and reports failures nobody has to fix — the same false-alarm
 * class as scoring `F 90` against `REI 90`, and just as effective at making a
 * checker unreadable.
 *
 * Matched per WORD, not as a bare substring of the whole name. `name.includes`
 * excluded `Level 2 Storey Plan Office` (`store` ⊂ `storey`, and every English
 * Revit template prefixes room names with the level), `Upstairs Bedroom`
 * (`stair`), `Showcase` (`wc`), `Implantologie` (`plant`), `Badminton-Halle`
 * and `Besprechung Bad Gastein` (`bad`). Those rooms did not fail the Raumhöhe
 * rule — they produced no row at all, which is the invisible false pass this
 * catalogue exists to refuse.
 *
 * The asymmetry is deliberate: when a name is ambiguous, CHECK the room. A
 * Technikraum wrongly held to 2,50 m is a visible row somebody can dismiss; an
 * Aufenthaltsraum silently dropped is a compliance gap nobody can see.
 */

/**
 * Positive signals. Checked FIRST, so one unambiguous word rescues a room from
 * a marker that happens to collide with it — `Büro Keller` (Keller is a common
 * Austrian surname and offices get named after their occupant),
 * `Besprechung Bad Gastein`, `Store (Verkauf)`.
 */
const OCCUPIED_MARKERS = [
  'wohn',
  'schlaf',
  'kind',
  'büro',
  'buero',
  'ess',
  'küche',
  'kueche',
  'arbeits',
  'besprechung',
  'aufenthalt',
  'unterricht',
  'klasse',
  'seminar',
  'verkauf',
  'praxis',
  'ordination',
  'office',
  'kitchen',
  'meeting',
  'living',
  'bed',
]

/**
 * Short or ambiguous markers, matched as a WHOLE word only. `gang` must not
 * take `Gangküche`, `bad` must not take `Badminton`, `wc` must not take
 * `Showcase`, `plant` must not take `Implantologie`.
 */
const NON_OCCUPIED_WORDS = new Set([
  'gang',
  'bad',
  'wc',
  'stair',
  'stairs',
  'store',
  'plant',
  'lobby',
  'toilet',
  'shaft',
  'hall',
])

/**
 * Unambiguous stems, matched at either END of a word — German builds compounds
 * in both directions (`Stiegenhaus`, `Installationsschacht`), and a stem this
 * long does not collide by accident.
 */
const NON_OCCUPIED_STEMS = [
  'flur',
  'stiege',
  'treppe',
  'technik',
  'schacht',
  'abstell',
  'lager',
  'garage',
  'vorraum',
  'keller',
  'bade',
  'sanitär',
  'sanitaer',
  'corridor',
  'hallway',
  'technical',
  'storage',
  'bathroom',
  'restroom',
  'utility',
  'circulation',
]

/** Free-text room names split into words: `TR 01 Stiegenhaus`, `WC-Vorraum`. */
function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^0-9a-zäöüß]+/u)
    .filter((word) => word !== '')
}

/**
 * `IfcSpaceTypeEnum` values that say NOTHING about whether people stay in the
 * room, so the name markers have to decide instead.
 *
 * The list is the whole point of the helper below. `NOTDEFINED` is what Revit
 * and ArchiCAD write for an ordinary room by default and `SPACE` is IFC4's own
 * generic value — treating either as "a type was published, and it is not one
 * of the two I recognise" dropped the majority of every real model's rooms out
 * of the Raumhöhe rule silently, which reads as a building with no
 * Aufenthaltsräume to check rather than as a rule that never ran.
 *
 * Everything NOT in this list is a real statement — `PARKING`, `EXTERNAL`,
 * `GFA` — and is believed.
 */
const UNINFORMATIVE_SPACE_TYPES = new Set(['', 'SPACE', 'INTERNAL', 'USERDEFINED', 'NOTDEFINED'])

/**
 * An Aufenthaltsraum, as far as the model lets us tell.
 *
 * `PredefinedType` is believed when the model publishes a meaningful one; the
 * name markers are the fallback for the overwhelming majority of exports that
 * publish one of {@link UNINFORMATIVE_SPACE_TYPES}.
 */
const isOccupiedSpace = (element: BimElement): boolean => {
  const predefined = (element.predefinedType ?? '').toUpperCase()
  if (!UNINFORMATIVE_SPACE_TYPES.has(predefined)) return false
  const words = nameWords(element.name ?? '')
  const edgeMatch = (word: string, stem: string): boolean =>
    word.startsWith(stem) || word.endsWith(stem)
  if (words.some((word) => OCCUPIED_MARKERS.some((marker) => edgeMatch(word, marker)))) return true
  return !words.some(
    (word) =>
      NON_OCCUPIED_WORDS.has(word) || NON_OCCUPIED_STEMS.some((stem) => edgeMatch(word, stem))
  )
}

/**
 * A number that IS a rated sound reduction, in one of the forms a real export
 * writes it: `Rw 53 dB`, `R'w = 55 dB`, `DnT,w 52`, `53 dB`, or a bare `53`.
 *
 * Deliberately NOT "the first number anywhere in the string". That was the
 * first attempt at this and it recreated the bug it was fixing from the other
 * side: `siehe OIB 5` parsed as 5, `ÖNORM B 8115-2` as 8115, and both were
 * then reported **erfüllt** under an OIB 5 caption. A number has to be
 * introduced by an acoustic label, followed by `dB`, or be the entire value —
 * three shapes, each of which means the author wrote a rating.
 *
 * The single-index alternation matters: `R'w = 55 dB` matches the labelled
 * branch on the first number after `R'w`, so a reference standing BEFORE a real
 * rating (`gemäß ÖNORM B 8115-2, Rw 55 dB`) still reads 55 rather than 8115.
 */
const ACOUSTIC_LABEL = /\b(?:R['´’]?\s*w|DnT\s*,?\s*w|D\s*n\s*T|Rw|SRI|Schalld[äa]mm[- ]?Ma[sß]{1,2})\b/i
const NUMBER = /-?\d+(?:[.,]\d+)?/

function ratedSoundReduction(raw: string | number | boolean | null): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null

  const parse = (token: string): number | null => {
    const value = Number(token.replace(',', '.'))
    return Number.isFinite(value) ? value : null
  }

  // 1. The whole value is the number — `53`, `52,5`.
  const bare = new RegExp(`^${NUMBER.source}$`).exec(text)
  if (bare) return parse(bare[0])

  // 2. Introduced by an acoustic label — `Rw 53 dB`, `R'w = 55`, `DnT,w 52`.
  const labelled = ACOUSTIC_LABEL.exec(text)
  if (labelled) {
    const after = new RegExp(NUMBER.source).exec(text.slice(labelled.index + labelled[0].length))
    if (after) return parse(after[0])
  }

  // 3. Followed by the unit — `53 dB`, `53dB`. A standard reference such as
  //    `ÖNORM B 8115-2` carries no `dB`, which is what keeps it out.
  const withUnit = new RegExp(`(${NUMBER.source})\\s*dB\\b`, 'i').exec(text)
  if (withUnit) return parse(withUnit[1])

  return null
}

export const BIM_RULES: RuleDefinition[] = [
  {
    id: 'oib4-treppe-steigungsverhaeltnis',
    richtlinie: 'OIB 4',
    clause: '2.2',
    titleDe: 'Treppen — Steigungsverhältnis',
    thresholdDe: '2 × Steigung + Auftritt = 59–65 cm, Steigung ≤ 18 cm, Auftritt ≥ 28 cm',
    ifcTypes: ['IfcStairFlight'],
    judge: (element, facts) => {
      const riser = toCentimetres(
        numericProperty(element, ['RiserHeight']) ?? quantity(element, ['RiserHeight']),
        facts.lengthScale
      )
      const tread = toCentimetres(
        numericProperty(element, ['TreadLength']) ?? quantity(element, ['TreadLength']),
        facts.lengthScale
      )
      if (riser === null || tread === null) {
        return {
          status: 'undecidable',
          reading:
            'Steigung oder Auftritt nicht im Modell veröffentlicht — Steigungsverhältnis nicht berechenbar',
          missing: 'IfcStairFlight.RiserHeight / TreadLength',
        }
      }
      // The ratio is deliberately compared at the precision it is shown at: a
      // millimetre on a 2h+b sum is below what a stair is built to, and the
      // displayed number is the one the comparison used, so the row stays
      // self-consistent. h and b are compared raw and so need `measure`.
      const ratio = round(2 * riser + tread, 1)
      const ok = ratio >= 59 && ratio <= 65 && riser <= 18 && tread >= 28
      return {
        status: ok ? 'pass' : 'fail',
        reading:
          `2h + b = ${decimal(ratio, 1)} cm (h = ${measure(riser, (h) => h <= 18, 1)} cm, ` +
          `b = ${measure(tread, (b) => b >= 28, 1)} cm) — ` +
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
    judge: (element, facts) => {
      // LICHTE Durchgangsbreite, which is not the door's nominal width. A
      // 0,90 m door leaf passes through a frame and over a stop, and the
      // clear opening it leaves is routinely 0,78 m — under the threshold the
      // nominal figure clears comfortably. Reading `Width` first therefore
      // passed doors that fail, on an escape-route rule.
      const clear = toMetres(
        quantity(element, ['ClearWidth']) ?? numericProperty(element, ['ClearWidth']),
        facts.lengthScale
      )
      if (clear !== null) {
        return {
          status: clear >= 0.8 ? 'pass' : 'fail',
          reading: `Lichte Durchgangsbreite ${measure(clear, (w) => w >= 0.8)} m — Schwellwert ≥ 0,80 m`,
        }
      }

      // Without it, the nominal width is still an UPPER BOUND on the clear
      // one, so it can settle a failure and never a pass. Reporting the pass
      // anyway is the whole class of error this catalogue exists to avoid.
      const nominal = toMetres(
        quantity(element, ['Width']) ?? numericProperty(element, ['OverallWidth', 'Width']),
        facts.lengthScale
      )
      if (nominal === null) {
        return {
          status: 'undecidable',
          reading: 'Keine Breite im Modell veröffentlicht',
          missing: 'Qto_DoorBaseQuantities.ClearWidth',
        }
      }
      if (nominal < 0.8) {
        return {
          status: 'fail',
          reading:
            `Nennbreite ${measure(nominal, (w) => w >= 0.8)} m — die lichte Durchgangsbreite ist kleiner und ` +
            'liegt damit unter dem Schwellwert von 0,80 m',
        }
      }
      return {
        status: 'undecidable',
        reading:
          `Nur die Nennbreite ${decimal(round(nominal), 2)} m veröffentlicht — die lichte ` +
          'Durchgangsbreite ist um Rahmen und Anschlag kleiner und nicht daraus ableitbar',
        missing: 'Qto_DoorBaseQuantities.ClearWidth',
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
    judge: (element, facts) => {
      // LICHTE Raumhöhe: the finished floor-to-ceiling dimension.
      // `Qto_SpaceBaseQuantities.Height` is the GROSS/structural space height
      // and the two are not interchangeable — floor build-up and a suspended
      // ceiling routinely take 15–25 cm out of it. Reading `Height` as though
      // it were the clear height passed a room that finishes at 2,42 m against
      // "lichte Raumhöhe ≥ 2,50 m", which is the false pass this catalogue
      // exists to refuse.
      const clear = toMetres(
        quantity(element, ['FinishCeilingHeight', 'ClearHeight']) ??
          numericProperty(element, ['FinishCeilingHeight', 'ClearHeight']),
        facts.lengthScale
      )
      if (clear !== null) {
        return {
          status: clear >= 2.5 ? 'pass' : 'fail',
          reading: `Lichte Raumhöhe ${measure(clear, (h) => h >= 2.5)} m — Schwellwert ≥ 2,50 m`,
        }
      }

      // The gross height is an UPPER BOUND on the clear one, so — exactly like
      // the door's nominal width — it can settle a failure and never a pass.
      const gross = toMetres(
        quantity(element, ['Height']) ?? numericProperty(element, ['Height']),
        facts.lengthScale
      )
      if (gross === null) {
        return {
          status: 'undecidable',
          reading: 'Keine Raumhöhe im Modell veröffentlicht',
          missing: 'Qto_SpaceBaseQuantities.FinishCeilingHeight',
        }
      }
      if (gross < 2.5) {
        return {
          status: 'fail',
          reading:
            `Brutto-Raumhöhe ${measure(gross, (h) => h >= 2.5)} m — die lichte Raumhöhe ist ` +
            'kleiner und liegt damit unter dem Schwellwert von 2,50 m',
        }
      }
      return {
        status: 'undecidable',
        reading:
          `Nur die Brutto-Raumhöhe ${decimal(round(gross), 2)} m veröffentlicht — die lichte ` +
          'Raumhöhe ist um Fußbodenaufbau und abgehängte Decke kleiner und nicht daraus ableitbar',
        missing: 'Qto_SpaceBaseQuantities.FinishCeilingHeight',
      }
    },
  },
  {
    id: 'oib2-feuerwiderstand-tragend',
    richtlinie: 'OIB 2',
    clause: '3',
    titleDe: 'Tragende Bauteile — Feuerwiderstand',
    thresholdDe:
      'R nach Gebäudeklasse und Geschoßlage (OIB 2, Tabelle 1b, Zeile 1): oberirdisch GK1/2 R 30 … GK5 R 90, unterirdisch GK1/2 R 60 … GK3+ R 90',
    // No IfcSlab: Tabelle 1b row 1 excludes Decken by its own title, and
    // they carry the different requirements of row 4.
    ifcTypes: ['IfcWall', 'IfcColumn', 'IfcBeam', 'IfcMember'],
    scope: mayBeLoadBearing,
    notApplicable: (facts) =>
      facts.gebaeudeklasse === undefined || facts.gebaeudeklasse === null
        ? 'Gebäudeklasse in den Projektangaben nicht gesetzt — die Anforderung hängt daran'
        : null,
    judge: (element, facts) => {
      // Scope admits elements whose load-bearing role is unstated; a rule
      // about tragende Bauteile cannot decide one of those either way.
      if (property(element, ['LoadBearing']) !== true) {
        return {
          status: 'undecidable',
          reading: 'Nicht angegeben, ob das Bauteil tragend ist — Anforderung nicht bestimmbar',
          missing: 'Pset_WallCommon.LoadBearing (bzw. Pset_*Common.LoadBearing)',
        }
      }
      // Which ROW of Tabelle 1b applies depends on where the storey sits.
      const position = classifyStorey(element.storeyName, facts.storeys)
      if (position === null) {
        return {
          status: 'undecidable',
          reading:
            'Geschoßlage des Bauteils nicht bestimmbar — die geforderte Feuerwiderstandsdauer ' +
            'hängt davon ab (oberirdisch, oberstes Geschoß oder Kellergeschoß)',
          missing: 'IfcBuildingStorey.Elevation (Höhenlage der Geschoße)',
        }
      }
      const minutes = FIRE_RESISTANCE_R_MINUTES[position][facts.gebaeudeklasse ?? 0]
      if (minutes === null) {
        return {
          status: 'pass',
          reading: `Im obersten Geschoß der Gebäudeklasse ${facts.gebaeudeklasse} wird kein Feuerwiderstand gefordert`,
        }
      }
      const required = minutes ? `R ${minutes}` : undefined
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
      const verdict = compareFireRating(declared, required)
      if (verdict === 'unreadable') {
        return {
          status: 'undecidable',
          reading:
            `Feuerwiderstand „${declared}“ nicht mit ${required} vergleichbar ` +
            '(andere oder unlesbare Klassifizierung) — bitte manuell prüfen',
          missing: 'Pset_WallCommon.FireRating in der Form „REI 90“',
        }
      }
      return {
        status: verdict === 'meets' ? 'pass' : 'fail',
        reading:
          `Feuerwiderstand ${declared} — erforderlich ${required} ` +
          `(Gebäudeklasse ${facts.gebaeudeklasse}, ${STOREY_LABEL[position]})`,
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
      // U = 0 is not a wall, it is an unset field an exporter wrote as zero.
      // Treating it as the best possible envelope is the single most
      // dangerous direction this rule can fail in.
      if (uValue <= 0) {
        return {
          status: 'undecidable',
          reading: `U = ${decimal(round(uValue), 2)} W/m²K ist kein physikalisch möglicher Wert — vermutlich nicht gesetzt`,
          missing: 'Pset_WallCommon.ThermalTransmittance (echter Wert, nicht 0)',
        }
      }
      return {
        status: uValue <= 0.35 ? 'pass' : 'fail',
        reading: `U = ${measure(uValue, (u) => u <= 0.35)} W/m²K — Schwellwert ≤ 0,35 W/m²K`,
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
      if (uValue <= 0) {
        return {
          status: 'undecidable',
          reading: `U = ${decimal(round(uValue), 2)} W/m²K ist kein physikalisch möglicher Wert — vermutlich nicht gesetzt`,
          missing: 'Pset_WindowCommon.ThermalTransmittance (echter Wert, nicht 0)',
        }
      }
      return {
        status: uValue <= 1.4 ? 'pass' : 'fail',
        reading: `U = ${measure(uValue, (u) => u <= 1.4)} W/m²K — Schwellwert ≤ 1,40 W/m²K`,
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
      // A DECLARATION is a rated value in decibels, not merely a non-empty
      // field. `numericProperty` is anchored at the start of the string, so it
      // parsed neither `Rw 30 dB` NOR `siehe Beilage` — and everything it failed
      // to parse fell through to `pass`. A wall whose AcousticRating read
      // "siehe Beilage", "keine Anforderung" or "tbd" was reported **erfüllt**
      // under an OIB 5 caption, which is the precise failure this catalogue
      // exists to prevent: stating something the model never said.
      const decibels = ratedSoundReduction(rating)
      if (decibels === null) {
        return {
          status: 'undecidable',
          reading: `„${String(rating)}“ ist kein bewertetes Schalldämm-Maß`,
          missing: 'Pset_WallCommon.AcousticRating (bewertetes Maß in dB, z. B. „Rw 53 dB“)',
        }
      }
      // `0` is what an exporter writes when nobody declared anything.
      if (decibels <= 0) {
        return {
          status: 'undecidable',
          reading: `Schalldämm-Maß ${String(rating)} ist kein bewertetes Maß — vermutlich nicht gesetzt`,
          missing: 'Pset_WallCommon.AcousticRating (echter Wert, nicht 0)',
        }
      }
      return {
        status: 'pass',
        reading: `Schalldämm-Maß ${decimal(decibels, 0)} dB hinterlegt (${String(rating)})`,
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Running the catalog
// ---------------------------------------------------------------------------

/**
 * IFC4 split several entities into `…StandardCase` / `…ElementedCase`
 * subtypes, and exporters pick whichever fits the component.
 *
 * The catalogue listed `IfcWall` and `IfcWallStandardCase` by hand and no
 * other pair, so an IFC4 model whose doors are `IfcDoorStandardCase` — which
 * ArchiCAD writes routinely — matched the door rule ZERO times and the
 * Prüfbuch simply had nothing to say about any door in the building. Silence
 * is the one output this product must never produce by accident, and
 * enumerating variants rule by rule guarantees the next one gets missed too.
 */
const CASE_SUFFIX = /(standardcase|elementedcase)$/

const normaliseType = (ifcType: string): string => ifcType.toLowerCase().replace(CASE_SUFFIX, '')

/**
 * Every stored spelling of one requested IFC type, lowercased.
 *
 * The same problem as {@link normaliseType}, one layer out. A filter asking
 * for `IfcWall` is asking about walls, and an IFC4 exporter that wrote
 * `IfcWallStandardCase` has written walls — but the query layer matched
 * `lower(ifc_type)` exactly, so the answer was "Kein Bauteil erfüllt die
 * Abfrage" and the agent reported a building with no walls in it.
 *
 * Expanded to a variant LIST rather than normalising the column, because
 * `regexp_replace(lower(ifc_type), …)` on every row cannot use the index the
 * element table is read through, and this is the hot path for every question
 * anyone asks about a building. Normalisation only ever strips these two
 * suffixes, so the expansion is exactly equivalent.
 *
 * Asking for `IfcWallStandardCase` matches plain `IfcWall` too, for the same
 * reason in the other direction: the caller is naming a kind of component,
 * not an exporter's choice of subtype.
 */
export function ifcTypeVariants(ifcType: string): string[] {
  const base = normaliseType(ifcType)
  return [base, `${base}standardcase`, `${base}elementedcase`]
}

const matchesType = (element: BimElement, types: readonly string[]): boolean =>
  types.some((type) => normaliseType(type) === normaliseType(element.ifcType))

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
    // ANY undecidable element keeps the rule out of the "erfüllt" count, even
    // when most of its elements passed. 9 erfüllt + 2 nicht entscheidbar used
    // to render as a green tick, which is precisely the reading this whole
    // three-state design exists to prevent: the two unknowns are the reason
    // the requirement is not settled, and averaging them away behind the nine
    // is what a two-state checker would do.
    else if (result.undecidable > 0) summary.rulesUndecidable += 1
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

// ---------------------------------------------------------------------------
// Human confirmations
// ---------------------------------------------------------------------------

/** A rule an architect settled themselves, recorded against a revision. */
export interface BimCheckConfirmation {
  ruleId: string
  /** The revision the person actually looked at. */
  modelId: string
  confirmedBy: string
  note: string | null
  confirmedAt: string
}

/** A rule result with whatever human verdict sits on top of it. */
export interface BimRuleResultWithConfirmation extends BimRuleResult {
  confirmation: BimCheckConfirmation | null
  /**
   * The confirmation was made against a DIFFERENT revision than the one shown.
   *
   * Not an error and not a reason to drop it — a reason to say so. "I checked
   * this" was true of the building that person looked at and says nothing about
   * the one that replaced it, so carrying it forward silently would let a
   * signature outlive the drawing it was made about.
   */
  confirmationStale: boolean
}

/**
 * Attach human verdicts to a run of the catalogue.
 *
 * Deliberately does NOT change any status. A confirmation sits BESIDE the
 * machine verdict rather than overwriting it: an architect who confirms a rule
 * the catalogue reports as failing has said "I know, and it is fine" — which
 * the reader needs to see as exactly that, not as a green tick that hides what
 * the model actually says.
 */
export function attachConfirmations(
  results: readonly BimRuleResult[],
  confirmations: readonly BimCheckConfirmation[],
  currentModelId: string
): BimRuleResultWithConfirmation[] {
  const byRule = new Map(confirmations.map((entry) => [entry.ruleId, entry]))
  return results.map((result) => {
    const confirmation = byRule.get(result.ruleId) ?? null
    return {
      ...result,
      confirmation,
      confirmationStale: confirmation !== null && confirmation.modelId !== currentModelId,
    }
  })
}

/**
 * Rules that leave work behind — a failure or an unknown, in scope.
 *
 * Distinct from {@link outstandingRules}, which asks the narrower question
 * "what still needs a HUMAN". This one ignores confirmations: a rule somebody
 * has signed off still describes something in the model that is wrong or
 * unstated, which is exactly what belongs in an export to the authoring tool.
 */
export function rulesWithOpenWork<T extends BimRuleResult>(results: readonly T[]): T[] {
  return results.filter((result) => result.applicable && (result.failed > 0 || result.undecidable > 0))
}

/**
 * What still needs a human before the Prüfbuch can be signed.
 *
 * A rule counts as outstanding when the catalogue could not settle it (or
 * settled it as a failure) and no CURRENT confirmation covers it. A stale
 * confirmation does not count — that is the point of tracking staleness.
 */
export function outstandingRules(
  results: readonly BimRuleResultWithConfirmation[]
): BimRuleResultWithConfirmation[] {
  return results.filter((result) => {
    if (!result.applicable) return false
    if (result.confirmation !== null && !result.confirmationStale) return false
    return result.failed > 0 || result.undecidable > 0
  })
}

// ---------------------------------------------------------------------------
// Regression across revisions
// ---------------------------------------------------------------------------

/** How a rule's standing moved between two revisions. */
export type BimComplianceTrend =
  /** Was failing (or undecidable), now passes. */
  | 'resolved'
  /** Was passing, now fails — the answer nobody gets today. */
  | 'broken'
  /** Became decidable: the model gained the property. */
  | 'decidable'
  /** Stopped being decidable: the model LOST the property. */
  | 'undecidable'
  /** Still failing, but a different number of elements. */
  | 'moved'

export interface BimComplianceChange {
  ruleId: string
  titleDe: string
  richtlinie: string
  trend: BimComplianceTrend
  before: { passed: number; failed: number; undecidable: number }
  after: { passed: number; failed: number; undecidable: number }
}

/** The verdict a rule's counts amount to, for trend purposes. */
function standing(result: BimRuleResult): 'pass' | 'fail' | 'unknown' | 'empty' {
  if (!result.applicable) return 'empty'
  if (result.failed > 0) return 'fail'
  if (result.passed === 0 && result.undecidable === 0) return 'empty'
  // ANY undecidable element leaves the rule unsettled, not passing. The
  // alternative reads a revision that dropped `FireRating` from half its walls
  // as "no change" — the rule stood at `pass` with 40 passed, and it still
  // stands at `pass` with 20 passed and 20 undecidable. That regression is
  // precisely what a diff is for, and it is the same unearned tick
  // `summarizeBimRules` refuses to show on the page.
  if (result.undecidable > 0) return 'unknown'
  return 'pass'
}

/**
 * What a new revision changed about the building's standing.
 *
 * This is the payoff of having verdicts at all. "188 Bauteile, +17" says a
 * revision happened; **"Treppe Ost erfüllt das Steigungsverhältnis nicht
 * mehr"** says what it did — and that is the sentence an architect cannot get
 * from any tool at a price a small office would pay.
 *
 * `undecidable` as a trend is deliberately reported and not swallowed: a
 * revision that DROPS a property (a re-export with a different mapping, a
 * Pset that stopped being written) silently un-checks a requirement that was
 * green yesterday. Reporting only pass↔fail would let that pass unnoticed,
 * which is the same silence the whole subsystem exists to break.
 *
 * Rules whose standing did not change are omitted — a change list that
 * restates everything is a list nobody reads.
 */
export function diffBimCompliance(
  before: readonly BimRuleResult[],
  after: readonly BimRuleResult[]
): BimComplianceChange[] {
  const previous = new Map(before.map((result) => [result.ruleId, result]))
  const changes: BimComplianceChange[] = []

  for (const now of after) {
    const then = previous.get(now.ruleId)
    if (!then) continue
    const from = standing(then)
    const to = standing(now)

    let trend: BimComplianceTrend | null = null
    if (from !== to) {
      if (to === 'pass') trend = from === 'unknown' ? 'decidable' : 'resolved'
      else if (to === 'fail') trend = 'broken'
      else if (to === 'unknown') trend = 'undecidable'
    } else if (to === 'fail' && then.failed !== now.failed) {
      // Same verdict, different scale. Worth surfacing: nine failing doors
      // becoming two is progress, and becoming ninety is a regression, and
      // neither shows up in a pass/fail comparison.
      trend = 'moved'
    }
    if (!trend) continue

    changes.push({
      ruleId: now.ruleId,
      titleDe: now.titleDe,
      richtlinie: now.richtlinie,
      trend,
      before: { passed: then.passed, failed: then.failed, undecidable: then.undecidable },
      after: { passed: now.passed, failed: now.failed, undecidable: now.undecidable },
    })
  }

  // Regressions first: what a revision BROKE is the reason to read this list.
  const order: Record<BimComplianceTrend, number> = {
    broken: 0,
    undecidable: 1,
    moved: 2,
    decidable: 3,
    resolved: 4,
  }
  return changes.sort(
    (a, b) => order[a.trend] - order[b.trend] || a.ruleId.localeCompare(b.ruleId)
  )
}

const TREND_DE: Record<BimComplianceTrend, string> = {
  broken: 'neu nicht erfüllt',
  undecidable: 'nicht mehr entscheidbar (Wert im Modell entfallen)',
  moved: 'weiterhin nicht erfüllt, andere Anzahl',
  decidable: 'jetzt entscheidbar und erfüllt',
  resolved: 'jetzt erfüllt',
}

/** German lines for the agent, regressions first. */
export function renderBimComplianceDiff(changes: readonly BimComplianceChange[]): string {
  if (changes.length === 0) {
    return 'Keine Anforderung hat ihren Status zwischen diesen beiden Ständen geändert.'
  }
  return changes
    .map(
      (change) =>
        `${change.richtlinie} — ${change.titleDe}: ${TREND_DE[change.trend]} ` +
        `(${change.before.passed}/${change.before.failed}/${change.before.undecidable} → ` +
        `${change.after.passed}/${change.after.failed}/${change.after.undecidable} ` +
        'erfüllt/nicht erfüllt/nicht entscheidbar)'
    )
    .join('\n')
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
