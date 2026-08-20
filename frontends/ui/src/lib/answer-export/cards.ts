/**
 * Grid cards, rendered into the document.
 *
 * A card is STRUCTURED DATA — the shapes live in `src/aiq_agent/cards/models.py`
 * and reach the browser as `metadata.cards`. In the app most of them are drawn
 * as SVG schematics; none of that can go into a .docx, and a screenshot of one
 * would not be a work product anyway (you cannot correct a number in a picture).
 * So each card is rendered as a titled table or a labelled block: the same
 * facts, in the form Word can carry, edit and search.
 *
 * ## One walker, not forty renderers
 *
 * The catalogue has forty card types and grows — it was twenty-seven when this
 * was written, which is the argument making itself. Forty bespoke renderers
 * would mean the export silently loses a card type on the day the
 * next one ships — the exact failure this feature exists to prevent, because a
 * finding missing from an exported file reads as a finding the answer never
 * made. So the renderer walks the card's OWN fields and dispatches on the shape
 * it finds:
 *
 *   - a `DimensionCheck` (`{label, value, required, unit, status}`) becomes a
 *     row in a checks table, wherever on the card it sits;
 *   - a `NormReference` becomes the Fundstelle line;
 *   - an array of objects becomes a table, one column per key;
 *   - an array of ARRAYS is a matrix — one row per entry — headed by whichever
 *     sibling field names its columns (see {@link headerFieldFor});
 *   - short scalars pair up into a two-column label/value table;
 *   - long prose gets a labelled paragraph of its own.
 *
 * ## Words, not payload
 *
 * Two vocabularies sit between the payload and the page, both in the
 * dictionary and both guarded against the schema by `label-coverage.spec.ts`:
 *
 *   - `fields.<name>` (with `fieldsByPath.<path>` overriding it where one name
 *     means two things — see {@link fieldLabel}) names the field;
 *   - `values.<name>.<member>` names a CLOSED VOCABULARY's member, so
 *     `direction: tightens` prints „verschärft“ and not `tightens`. A member
 *     this build has never heard of falls back to itself rather than to
 *     nothing, on the same reasoning as an unknown field name.
 *
 * A card type that is not in {@link FIELD_ORDER} still exports every field it
 * carries; the order list only decides READING order, which is otherwise lost —
 * `metadata` is a jsonb column, and Postgres does not preserve key order.
 *
 * ## The cards that cannot be represented, and are not dropped
 *
 * The `ifc_*` cards deliberately carry no values at all — a GlobalId, a rule id,
 * a file name — because the frontend reads every number live from the model so
 * the model cannot be misquoted. A document cannot do that, so those cards are
 * exported as their title plus one line saying so. Silence would tell the
 * reader the answer had no such finding.
 *
 * ## The cards that are chrome, and ARE dropped
 *
 * See {@link CARD_EXPORT}. A handful of card types are the app talking to the
 * reader rather than the answer stating a finding, and a document whose purpose
 * is to record what was established has no place for them.
 */

import type { Translator } from '@/i18n/translate'
// The canonical dictionary, read for its SHAPE and never for its words: which
// payload paths carry a label override, and which field names carry a closed
// vocabulary. Every locale is annotated `typeof en.answerExport`, so that shape
// is the same in all of them — reading it off English decides only WHETHER to
// look a word up, and the word itself still comes from `t`. The alternative was
// probing `t` for keys that are usually absent, which warns once per miss and
// would have filled every dev console with the walker's own guesses.
import { answerExport as canonicalDictionary } from '@/i18n/dictionaries/en/answer-export'
import type { GridCard } from '@/shared/cards/schemas'
import { compact, type DocBlock, type DocRun } from './blocks'
import { diagramLabel } from './markdown'

/** A stored card: validated upstream, but read here as untrusted jsonb. */
type CardRecord = Record<string, unknown>

const isRecord = (value: unknown): value is CardRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `{a: {b: 'x'}}` → `a.b`. Keys never contain a dot, so this is lossless. */
const flattenKeys = (node: unknown, prefix: string, into: Set<string>): Set<string> => {
  if (typeof node === 'string') {
    into.add(prefix)
    return into
  }
  if (isRecord(node)) {
    for (const [key, child] of Object.entries(node)) {
      flattenKeys(child, prefix ? `${prefix}.${key}` : key, into)
    }
  }
  return into
}

/**
 * The payload paths `fieldsByPath` overrides, as the walker spells them.
 *
 * A membership test rather than a `t` lookup: the override is the rare case,
 * and asking the translator for a key that is usually absent warns on every
 * miss.
 */
const OVERRIDDEN_PATHS = flattenKeys(canonicalDictionary.fieldsByPath, '', new Set<string>())

/**
 * The closed vocabularies, as `field -> members`.
 *
 * The MEMBERS are wire values and identical in every locale, so testing
 * membership here rather than by asking `t` keeps the walker silent on the
 * fields that are free text — `source` is an enum on `document_grid.documents`
 * and a half-line of prose on `calculation.steps.operands`, and probing the
 * translator for „Einreichplan, Schnitt A-A“ warns once per cell.
 *
 * Keying by NAME rather than by path is precise everywhere the catalogue is:
 * no two of the thirteen vocabularies share a member spelling. `source` is the
 * one place it is merely lucky — an operand whose source read exactly
 * „projekt“ would come out capitalised — and that is the whole cost of a
 * walker that needs no schema at runtime.
 */
const VOCABULARIES = new Map<string, Set<string>>(
  Object.entries(canonicalDictionary.values).map(([field, members]) => [
    field,
    new Set(Object.keys(members)),
  ])
)

/**
 * What a card type contributes to an exported document.
 *
 *   - `content` — a finding. Walked field by field; the overwhelming default.
 *   - `live` — its values are fetched from the project's IFC model at render
 *     time, so a document cannot carry them. Exported as its title plus one
 *     line saying so, because silence would tell the reader the answer had no
 *     such finding. Listed by name rather than detected, because "carries no
 *     values" is a property of the card's CONTRACT, not of one instance: an
 *     `ifc_schedule` with a `storey` set still has no areas in it, and guessing
 *     from the payload would start exporting these the day one of them grows a
 *     scalar field.
 *   - `diagram` — a drawing this export cannot draw. Mermaid lays a graph out
 *     against a DOM and this runs server-side, which is the same constraint
 *     that put diagram rendering in the browser to begin with. Exported the way
 *     a mermaid FENCE already is (`diagramLabel` in `./markdown.ts`): the
 *     labelled source, so the reader holding only the file can tell a drawing
 *     from prose and can regenerate it. Walking it instead would print the
 *     mermaid under „Origin“ as if the answer had meant to state it.
 *   - `chrome` — the app addressing the reader, not the answer recording a
 *     finding. Emitted as nothing at all.
 */
type ExportKind = 'content' | 'live' | 'diagram' | 'chrome'

/**
 * ⚠️ ADDING A CARD TYPE? YOU MUST CLASSIFY IT HERE. ⚠️
 *
 * Exhaustive over `GridCard['type']`, so `npm run generate:cards` regenerating
 * the union with a new type is a `tsc` failure until a line is added — the same
 * checkpoint `CARD_INTERACTIVITY` provides for card decisions, and for the same
 * reason: the alternative is a card type that quietly does the wrong thing in a
 * file that has already left the product.
 *
 * Classify as `chrome` only when the card asks something rather than states
 * something. The test is what a Behörde would make of it in a Bauakt: an
 * unanswered question, a picker, or a proposal awaiting a decision the document
 * cannot report the outcome of is not a finding, and printing it under „Befunde“
 * claims it is one. Everything else is `content` — a card missing from an
 * exported file reads as a finding the answer never made, which is the failure
 * this whole feature exists to prevent, so the doubtful case exports.
 */
export const CARD_EXPORT: Record<GridCard['type'], ExportKind> = {
  // Three questions this answer did NOT answer, offered as composer prefills.
  // The card charter says of this one that it "must never be screenshotted into
  // a submission" (docs/design/grid-card-charter.md §B1) — it is the one card
  // that is not evidence.
  follow_ups: 'chrome',
  // A picker: tiles that open one of the project's IFC models in the viewer. It
  // carries no file names at all (the renderer resolves them from the live
  // model list), so on paper it is a heading asking which model you meant.
  ifc_model_picker: 'chrome',
  // The two interactive cards (ADR-0030). Both ASK — "Remember this?", "Update
  // the project brief?" — and the answer lives in `metadata.cardInteractions`,
  // which the export never reads. So the document cannot say whether the user
  // accepted or declined, and printing the proposal as a finding states a
  // change to the brief that may never have been applied.
  memory_proposal: 'chrome',
  project_profile_patch: 'chrome',

  // The drawing whose source the model wrote. Same treatment as a mermaid fence
  // in the prose, deliberately: a reader must not get two different things for
  // the same picture depending on whether the model reached for a card or a
  // fence (`markdown.ts`, commit f21dcb5c).
  diagram: 'diagram',

  // Read live from the project's model; exported as a title plus `liveCard`.
  ifc_viewer: 'live',
  ifc_compliance: 'live',
  ifc_schedule: 'live',
  ifc_element: 'live',
  ifc_diff: 'live',

  // Findings. Walked field by field.
  summary: 'content',
  legal_basis: 'content',
  requirement_checklist: 'content',
  comparison_table: 'content',
  verdict_header: 'content',
  condition_tree: 'content',
  typed_table: 'content',
  norm_chain: 'content',
  key_takeaways: 'content',
  callout: 'content',
  calculation: 'content',
  process_map: 'content',
  document_checklist: 'content',
  deadline_timeline: 'content',
  change_impact: 'content',
  building_section: 'content',
  stair_diagram: 'content',
  dimension_diagram: 'content',
  setback_plan: 'content',
  egress_diagram: 'content',
  daylight_incidence: 'content',
  guardrail_check: 'content',
  density_check: 'content',
  fire_access_plan: 'content',
  acoustic_check: 'content',
  fire_compartment: 'content',
  thermal_envelope: 'content',
  energy_performance: 'content',
  elevator_requirement: 'content',
  parking_requirement: 'content',
  document_grid: 'content',
}

/**
 * How this build would export a stored card of the given type.
 *
 * Unknown types export as `content`. Old messages are re-read on every export
 * and a stored card may name a type this build has never heard of — one emitted
 * before a rename, or by a newer backend against an older frontend. Dropping it
 * would lose a finding; walking its fields prints what it carries.
 */
export const exportKindOf = (type: string): ExportKind =>
  CARD_EXPORT[type as GridCard['type']] ?? 'content'

/**
 * Fields no card should print, at the card's TOP level.
 *
 * Exported so `label-coverage.spec.ts` can subtract exactly what the walker
 * subtracts, rather than keeping a second copy that would drift. Nested objects
 * drop only `type` — see {@link nestedText}.
 */
export const SKIPPED_FIELDS = new Set([
  // The discriminator; the heading already says what this card is.
  'type',
  // Rendered as the heading.
  'title',
  // Model-supplied and explicitly "not rendered" by the card itself — the app
  // derives the before/after rows from the patch and the live profile instead.
  // Exporting it would show the reader a preview the product refuses to trust.
  'preview',
])

/**
 * Reading order per card type, taken from the declaration order in
 * `models.py` — which is the order the author of the card meant it to be read
 * in, and the only place that order still exists once jsonb has sorted the keys.
 */
const FIELD_ORDER: Record<string, string[]> = {
  summary: ['content', 'key_points'],
  legal_basis: ['law', 'article', 'section', 'summary', 'original_text'],
  project_profile_patch: ['rationale', 'patch'],
  memory_proposal: ['kind', 'confidence', 'content'],
  requirement_checklist: ['items', 'reference', 'note'],
  comparison_table: ['options', 'rows', 'recommendation', 'reference', 'note'],
  building_section: ['storeys', 'markers', 'reference', 'note'],
  stair_diagram: ['riser_count', 'riser_height', 'tread_depth', 'width', 'comfort_note', 'reference'],
  dimension_diagram: ['shape', 'dimensions', 'reference', 'note'],
  setback_plan: [
    'parcel_width_m',
    'parcel_depth_m',
    'building_width_m',
    'building_depth_m',
    'sides',
    'reference',
  ],
  egress_diagram: ['start_label', 'exit_label', 'segments', 'total_length', 'reference'],
  daylight_incidence: [
    'room_floor_area_m2',
    'window_sill_height_m',
    'window_head_height_m',
    'glass_area',
    'obstruction',
    'reference',
    'note',
  ],
  guardrail_check: [
    'context',
    'fall_height',
    'rail_height',
    'max_opening',
    'bottom_gap',
    'has_horizontal_elements_in_climb_zone',
    'reference',
    'note',
  ],
  density_check: [
    'parcel_area_m2',
    'footprint_area_m2',
    'gross_floor_area_m2',
    'coverage',
    'density',
    'reference',
    'note',
  ],
  fire_access_plan: [
    'gebaeudeklasse',
    'parcel_width_m',
    'parcel_depth_m',
    'building_width_m',
    'building_depth_m',
    'route_width',
    'gate_clearance_height',
    'aufstellflaeche',
    'walk_distance_to_entrance',
    'reference',
    'note',
  ],
  acoustic_check: ['sound_class', 'checks', 'note'],
  fire_compartment: ['storey_label', 'gebaeudeklasse', 'compartments', 'reference', 'note'],
  thermal_envelope: ['components', 'reference', 'note'],
  energy_performance: ['energy_class', 'hwb', 'fgee', 'reference', 'note'],
  elevator_requirement: [
    'storeys_served',
    'entrance_level_index',
    'is_required',
    'requirement_note',
    'cabin_width',
    'cabin_depth',
    'door_width',
    'reference',
    'note',
  ],
  parking_requirement: ['car_spaces', 'bicycle_spaces', 'basis', 'reference', 'note'],
  document_grid: ['query', 'documents'],
  typed_table: ['columns', 'rows', 'reference', 'note'],
}

/** Above this, a string is prose and gets its own paragraph rather than a cell. */
const PROSE_LENGTH = 90

/**
 * A `DimensionCheck`.
 *
 * Exported for `answer-document.spec.ts`, which has to subtract exactly what
 * the walker subtracts rather than keep a second copy of the shape test — the
 * same reasoning as {@link SKIPPED_FIELDS}.
 */
export const isCheck = (value: unknown): value is CardRecord =>
  isRecord(value) &&
  typeof value.status === 'string' &&
  ('value' in value || 'required' in value || 'unit' in value)

const isReference = (value: unknown): value is CardRecord =>
  isRecord(value) && typeof value.document === 'string' && !('status' in value)

/**
 * The human label for a payload field name, wherever the name appears.
 *
 * The flat `fields` map is the default and stays the common case. See
 * {@link fieldLabel} for the paths that override it.
 */
const flatLabel = (name: string, t: Translator): string => {
  const label = t(`fields.${name}`)
  // `createTranslator` returns the dot-path when a key is missing. A card type
  // added upstream must still export with readable labels rather than with
  // `answerExport.fields.new_thing`, so an unknown name degrades to itself.
  return label.startsWith('answerExport.fields.') ? humanize(name) : label
}

/**
 * The override key for a payload path, or `null` when the flat map is right.
 *
 * Two forms, both spelled the way the walker spells the path it is standing at
 * (`calculation.limit.value`, `document_checklist.items`):
 *
 *   - `<path>` — this field means something different HERE than the name says
 *     everywhere else;
 *   - `<path>?<sibling>=<member>` — it means something different here only when
 *     a sibling field carries a particular value. `CalculationLimit.value` is
 *     the bound, and with `comparator: 'between'` it is specifically the LOWER
 *     bound; nothing else in the catalogue has a label that turns on a
 *     sibling's value (`CalculationStep.unit` is ignored on a `percent_ratio`
 *     step, but that suppresses the field rather than renaming it).
 *
 * A variant wins over the plain path. Two variants matching at once would be
 * ambiguous, so `label-coverage.spec.ts` requires every variant at a path to
 * name the same sibling.
 */
const overrideKey = (path: string, siblings: CardRecord | undefined): string | null => {
  if (siblings) {
    for (const [name, value] of Object.entries(siblings)) {
      if (typeof value !== 'string') continue
      const variant = `${path}?${name}=${value}`
      if (OVERRIDDEN_PATHS.has(variant)) return variant
    }
  }
  return OVERRIDDEN_PATHS.has(path) ? path : null
}

/**
 * The human label for the field the walker is standing at.
 *
 * `path` is the card type plus every field name descended through, which is
 * exactly the path `label-coverage.spec.ts` derives from the card schema — so
 * an override naming a path the schema no longer has is a failing test rather
 * than an override that quietly stops applying. `siblings` is the record the
 * field sits in, for the overrides that turn on a sibling's value.
 */
const fieldLabel = (
  path: string,
  name: string,
  t: Translator,
  siblings?: CardRecord
): string => {
  const key = overrideKey(path, siblings)
  return key ? t(`fieldsByPath.${key}`) : flatLabel(name, t)
}

const humanize = (name: string): string =>
  name.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase())

/**
 * A member of a closed vocabulary, as the word the reader knows it by.
 *
 * `tightens` is not a German word and neither is `verordnung` a label; both are
 * wire values whose MEANING the app already spells out on screen
 * (`chat.cards.changeImpact.direction`, `chat.cards.normChain.rank`). A
 * document that prints the wire value instead has lost the part of the card
 * that carried the finding — which the card charter forbids by name (§D5).
 *
 * A value that is not a member of its field's vocabulary — free text under a
 * name that elsewhere is an enum, or a member added by a newer backend — is
 * returned unchanged, on the same reasoning as an unknown field name. That
 * fallback is why `label-coverage.spec.ts` has to derive the members from the
 * schema: nothing at runtime would notice a missing one.
 */
const valueText = (name: string, value: string, t: Translator): string =>
  VOCABULARIES.get(name)?.has(value) ? t(`values.${name}.${value}`) : value

/**
 * A scalar, as text.
 *
 * Numbers are printed verbatim rather than locale-formatted on purpose: the
 * figure in the document has to be the figure in the answer and in the model,
 * and a decimal separator swapped on the way out is a number the reader cannot
 * match against either.
 */
const scalarText = (name: string, value: unknown, t: Translator): string => {
  if (typeof value === 'boolean') return t(value ? 'boolean.true' : 'boolean.false')
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return valueText(name, value, t)
  return ''
}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const statusText = (value: unknown, t: Translator): string =>
  typeof value === 'string' ? valueText('status', value, t) : ''

/** `2.47 cm`, or the empty string when the number was never stated. */
const measure = (value: unknown, unit: unknown): string => {
  if (typeof value !== 'number') return ''
  const suffix = typeof unit === 'string' && unit ? ` ${unit}` : ''
  return `${value}${suffix}`
}

/** A `NormReference` on one line: regulation, clause, edition. */
const referenceText = (reference: CardRecord): string =>
  [reference.document, reference.section, reference.edition]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(', ')

/**
 * A `DimensionCheck` as one row of the checks table.
 *
 * The qualifiers ride along with the measured value rather than in a column of
 * their own: `provenance` and `tolerance` are the difference between reporting
 * the architect's file and reporting our own measurement, and a table that
 * drops them turns our tolerance into their claim (see `DimensionCheck` in
 * models.py). `missing` is the sentence the reader acts on, so it is appended
 * to the verdict rather than left in the payload.
 */
const checkRow = (
  path: string,
  name: string,
  check: CardRecord,
  t: Translator
): DocRun[][] => {
  const provenance =
    typeof check.provenance === 'string' ? valueText('provenance', check.provenance, t) : ''
  const qualifier = provenance && provenance !== check.provenance ? ` (${provenance})` : ''
  // The tolerance sits between the figure and its unit — `18.2 ±0.5 cm`, the
  // way a Bauphysik report writes it — so the band is read as part of the
  // measurement rather than as a second quantity.
  const unit = typeof check.unit === 'string' && check.unit ? ` ${check.unit}` : ''
  const tolerance = typeof check.tolerance === 'number' ? ` ±${check.tolerance}` : ''
  const actual =
    typeof check.value === 'number' ? `${check.value}${tolerance}${unit}` : ''
  const required = measure(check.required, check.unit)
  const comparator = typeof check.comparator === 'string' ? `${check.comparator} ` : ''
  const missing = typeof check.missing === 'string' && check.missing ? `\n${check.missing}` : ''

  return [
    [{ text: (typeof check.label === 'string' && check.label) || fieldLabel(path, name, t) }],
    [{ text: actual ? `${actual}${qualifier}` : '' }],
    [{ text: required ? `${comparator}${required}` : '' }],
    [{ text: `${statusText(check.status, t)}${missing}` }],
  ]
}

/**
 * Anything nested inside a table cell, flattened to text.
 *
 * `path` and `name` travel with the value so a leaf three levels down is
 * labelled and spelled by the same two vocabularies a top-level field is. An
 * array keeps its field's path: its entries are that field, not children of it.
 */
const nestedText = (path: string, name: string, value: unknown, t: Translator): string => {
  if (isScalar(value)) return scalarText(name, value, t)
  if (Array.isArray(value)) {
    return value
      .map((entry) => nestedText(path, name, entry, t))
      .filter(Boolean)
      .join('; ')
  }
  if (isCheck(value)) {
    // The check's own `label` is deliberately not repeated here. Nested, a
    // check always hangs off a named field — „Breite“ under „Aufstellfläche“,
    // a „Prüfung“ column beside its `metric` — and that name is already on the
    // page, so printing the check's label as well would name the same quantity
    // twice in one cell. At the card's top level there IS no other name, which
    // is why `checkRow` prefers it there.
    const actual = measure(value.value, value.unit)
    const required = measure(value.required, value.unit)
    // The comparator stays the symbol it is written as here, because it sits
    // directly in front of the figure — `(<= 18 cm)` reads as one quantity
    // where „(höchstens 18 cm)“ reads as a sentence inside a cell.
    const comparator = typeof value.comparator === 'string' ? `${value.comparator} ` : ''
    return [actual, required ? `(${comparator}${required})` : '', statusText(value.status, t)]
      .filter(Boolean)
      .join(' ')
  }
  if (isReference(value)) return referenceText(value)
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([key]) => key !== 'type')
      .map(
        ([key, entry]) =>
          `${fieldLabel(`${path}.${key}`, key, t, value)}: ${nestedText(`${path}.${key}`, key, entry, t)}`
      )
      .filter((part) => !part.endsWith(': '))
      .join('; ')
  }
  return ''
}

/**
 * An array of objects as a table, one column per key.
 *
 * Columns come from the union of every row's keys in first-seen order, so a row
 * that carries an optional field the others lack still shows it. `status` is
 * translated, everything else is flattened — a nested `DimensionCheck` (a
 * compartment's area, a component's U-value) becomes one readable cell rather
 * than a table inside a table, which Word renders but nobody reads.
 */
const objectTable = (path: string, rows: CardRecord[], t: Translator): DocBlock => {
  const keys: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key !== 'type' && !keys.includes(key)) keys.push(key)
    }
  }
  return {
    kind: 'table',
    // No siblings: a header stands over every row, so it cannot depend on the
    // value one of them happens to carry.
    head: keys.map((key) => fieldLabel(`${path}.${key}`, key, t)),
    rows: rows.map((row) =>
      keys.map((key) => [{ text: nestedText(`${path}.${key}`, key, row[key], t) }])
    ),
  }
}

/**
 * An array of arrays as a table, one row per entry.
 *
 * `typed_table.rows` is the shape: `list[list[str]]`, one cell per column, and
 * the walker's other two array branches both miss it — the entries are neither
 * scalars nor records, so before this existed the card exported its column
 * headers and not one of its rows. `head` comes from a sibling field that names
 * the columns (see {@link headerFieldFor}); without one the matrix is still
 * exported, headerless, because unnamed data beats no data.
 */
const matrixTable = (matrix: unknown[][], head: string[] | undefined, t: Translator): DocBlock => ({
  kind: 'table',
  head,
  // Cells are plain values in a column whose meaning the header carries, so
  // they are spelled with no field name of their own.
  rows: matrix.map((row) => row.map((value) => [{ text: nestedText('', '', value, t) }])),
})

const isMatrix = (value: unknown): value is unknown[][] =>
  Array.isArray(value) && value.length > 0 && value.every((row) => Array.isArray(row))

/**
 * The sibling field that names a matrix's columns, if the card has one.
 *
 * A shape rule, not a card-type list: a matrix `n` cells wide is headed by a
 * sibling array of exactly `n` labelled objects. `typed_table` is the only card
 * in the catalogue built that way today (its `_square_rows` validator is what
 * makes the widths agree), and a second one would be picked up without this
 * function learning its name.
 */
const headerFieldFor = (card: CardRecord, matrix: unknown[][]): string | null => {
  const width = Math.max(...matrix.map((row) => row.length))
  for (const [name, value] of Object.entries(card)) {
    if (SKIPPED_FIELDS.has(name) || value === matrix) continue
    if (!Array.isArray(value) || value.length !== width) continue
    const labels = value.every(
      (entry) => isRecord(entry) && typeof entry.label === 'string' && entry.label.trim()
    )
    if (labels) return name
  }
  return null
}

/** Accumulates adjacent fields of the same shape so they share one table. */
class CardBody {
  readonly blocks: DocBlock[] = []
  private scalars: DocRun[][][] = []
  private checks: DocRun[][][] = []

  constructor(private readonly t: Translator) {}

  scalar(path: string, name: string, value: unknown, siblings: CardRecord): void {
    this.flushChecks()
    this.scalars.push([
      [{ text: fieldLabel(path, name, this.t, siblings) }],
      [{ text: scalarText(name, value, this.t) }],
    ])
  }

  check(path: string, name: string, value: CardRecord): void {
    this.flushScalars()
    this.checks.push(checkRow(path, name, value, this.t))
  }

  block(block: DocBlock): void {
    this.flush()
    this.blocks.push(block)
  }

  /** A labelled paragraph — used for prose fields and for the Fundstelle. */
  labelled(label: string, text: string, style?: 'body' | 'quote'): void {
    this.flush()
    this.blocks.push({ kind: 'paragraph', runs: [{ text: label, bold: true }] })
    this.blocks.push({ kind: 'paragraph', runs: [{ text }], style: style ?? 'body' })
  }

  flush(): void {
    this.flushScalars()
    this.flushChecks()
  }

  private flushScalars(): void {
    if (this.scalars.length === 0) return
    this.blocks.push({ kind: 'table', rows: this.scalars })
    this.scalars = []
  }

  private flushChecks(): void {
    if (this.checks.length === 0) return
    this.blocks.push({
      kind: 'table',
      // Headed from the flat map alone: these four columns stand over rows
      // gathered from several different fields, so no one path owns them.
      head: [
        flatLabel('label', this.t),
        flatLabel('value', this.t),
        flatLabel('required', this.t),
        flatLabel('status', this.t),
      ],
      rows: this.checks,
    })
    this.checks = []
  }
}

/** Fields in reading order: the declared order first, then anything unlisted. */
const orderedFields = (card: CardRecord, type: string): string[] => {
  const declared = FIELD_ORDER[type] ?? []
  const present = Object.keys(card).filter((key) => !SKIPPED_FIELDS.has(key))
  const ordered = declared.filter((key) => present.includes(key))
  return [...ordered, ...present.filter((key) => !ordered.includes(key))]
}

/**
 * The heading for one card.
 *
 * `title` when the card carries one, otherwise the card type's own name — which
 * `legal_basis` needs, because it is the one card in the catalogue with no
 * title field at all.
 */
const cardHeading = (card: CardRecord, type: string, t: Translator): string => {
  const title = typeof card.title === 'string' ? card.title.trim() : ''
  if (title) return title
  const name = t(`cardTypes.${type}`)
  return name.startsWith('answerExport.cardTypes.') ? humanize(type) : name
}

/** Render one stored card. Returns no blocks for something that is not a card. */
export function cardBlocks(value: unknown, t: Translator): DocBlock[] {
  if (!isRecord(value)) return []
  const card = value
  const type = card.type
  // Narrowed here rather than in the guard above: `type` is read off an index
  // signature, so a `typeof` on `value.type` does not survive the assignment.
  if (typeof type !== 'string') return []

  const kind = exportKindOf(type)
  // Nothing at all — not even the heading. A „Weiterführende Fragen“ heading
  // with no questions under it would still put the app's own chrome inside the
  // findings section.
  if (kind === 'chrome') return []

  const heading: DocBlock = { kind: 'heading', level: 3, text: cardHeading(card, type, t) }

  if (kind === 'diagram') {
    const source = typeof card.source === 'string' ? card.source.trim() : ''
    const caption = typeof card.caption === 'string' ? card.caption.trim() : ''
    const reference = isReference(card.reference) ? referenceText(card.reference) : ''
    return compact([
      heading,
      // BEFORE the source, not after: a caption that arrives after the thing it
      // explains is a caption the reader has already misread.
      { kind: 'paragraph', runs: [{ text: diagramLabel('mermaid'), italic: true }], style: 'meta' },
      source ? { kind: 'paragraph', runs: [{ text: source, mono: true }] } : null,
      caption ? { kind: 'paragraph', runs: [{ text: caption }] } : null,
      // The Fundstelle, in the two-paragraph form the walker gives every other
      // card's reference — a procedure differs by Bundesland, so a drawing of
      // one without it is a procedure from nowhere.
      ...(reference
        ? [
            { kind: 'paragraph' as const, runs: [{ text: fieldLabel('diagram.reference', 'reference', t, card), bold: true }] },
            { kind: 'paragraph' as const, runs: [{ text: reference }], style: 'body' as const },
          ]
        : []),
    ])
  }

  if (kind === 'live') {
    const note = typeof card.note === 'string' ? card.note.trim() : ''
    return compact([
      heading,
      note ? { kind: 'paragraph', runs: [{ text: note }] } : null,
      { kind: 'paragraph', runs: [{ text: t('liveCard') }], style: 'meta' },
    ])
  }

  const body = new CardBody(t)
  const fields = orderedFields(card, type)

  // Which field heads which matrix, resolved before the walk so the header
  // field is not ALSO printed as a table of its own — `typed_table` would
  // otherwise carry its column names twice, once as data and once as a header.
  const headerFields = new Map<string, string>()
  const consumed = new Set<string>()
  for (const name of fields) {
    const field = card[name]
    if (!isMatrix(field)) continue
    const header = headerFieldFor(card, field)
    if (header && !consumed.has(header)) {
      headerFields.set(name, header)
      consumed.add(header)
    }
  }

  for (const name of fields) {
    const field = card[name]
    if (field === null || field === undefined) continue
    if (consumed.has(name)) continue
    const path = `${type}.${name}`

    if (isCheck(field)) {
      body.check(path, name, field)
      continue
    }

    if (isReference(field)) {
      const text = referenceText(field)
      if (text) body.labelled(fieldLabel(path, name, t, card), text)
      const excerpt = typeof field.excerpt === 'string' ? field.excerpt.trim() : ''
      // The literal sentence the value rests on. Quoted, never paraphrased —
      // it is the one part of a card a reviewer checks against the regulation.
      if (excerpt) body.block({ kind: 'paragraph', runs: [{ text: `„${excerpt}“` }], style: 'quote' })
      continue
    }

    if (Array.isArray(field)) {
      if (field.length === 0) continue
      const label = fieldLabel(path, name, t, card)
      if (isMatrix(field)) {
        const header = headerFields.get(name)
        const head = header
          ? (card[header] as CardRecord[]).map((column) => String(column.label))
          : undefined
        body.flush()
        // A headed matrix needs no label of its own: the card's title stands
        // over it and the header row names every column, so the field's own
        // name („Kriterien“ over a `typed_table`) would only mis-describe it.
        if (!head) body.block({ kind: 'paragraph', runs: [{ text: label, bold: true }] })
        body.block(matrixTable(field, head, t))
        continue
      }
      if (field.every((entry) => isScalar(entry))) {
        body.flush()
        body.block({ kind: 'paragraph', runs: [{ text: label, bold: true }] })
        body.block({
          kind: 'bullets',
          items: field.map((entry) => [{ text: scalarText(name, entry, t) }]),
        })
        continue
      }
      const rows = field.filter(isRecord)
      if (rows.length > 0) {
        body.flush()
        body.block({ kind: 'paragraph', runs: [{ text: label, bold: true }] })
        body.block(objectTable(path, rows, t))
      }
      continue
    }

    if (isRecord(field)) {
      const text = nestedText(path, name, field, t)
      if (text) body.labelled(fieldLabel(path, name, t, card), text)
      continue
    }

    if (isScalar(field)) {
      const text = scalarText(name, field, t)
      if (!text.trim()) continue
      if (text.length > PROSE_LENGTH || text.includes('\n')) {
        body.labelled(fieldLabel(path, name, t, card), text)
      } else {
        body.scalar(path, name, field, card)
      }
    }
  }

  body.flush()
  return compact([heading, ...body.blocks])
}

/** Render every card on an answer, in the order the answer emitted them. */
export function cardsBlocks(cards: unknown, t: Translator): DocBlock[] {
  if (!Array.isArray(cards)) return []
  return cards.flatMap((card) => cardBlocks(card, t))
}
