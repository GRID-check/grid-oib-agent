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
 *   - short scalars pair up into a two-column label/value table;
 *   - long prose gets a labelled paragraph of its own.
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
import type { GridCard } from '@/shared/cards/schemas'
import { compact, type DocBlock, type DocRun } from './blocks'

/** A stored card: validated upstream, but read here as untrusted jsonb. */
type CardRecord = Record<string, unknown>

const isRecord = (value: unknown): value is CardRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
 *   - `chrome` — the app addressing the reader, not the answer recording a
 *     finding. Emitted as nothing at all.
 */
type ExportKind = 'content' | 'live' | 'chrome'

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
 * cannot report the outcome of is not a finding, and printing it under „Befunde"
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

/** Fields no card should print. */
const SKIPPED_FIELDS = new Set([
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
}

/** Above this, a string is prose and gets its own paragraph rather than a cell. */
const PROSE_LENGTH = 90

const isCheck = (value: unknown): value is CardRecord =>
  isRecord(value) &&
  typeof value.status === 'string' &&
  ('value' in value || 'required' in value || 'unit' in value)

const isReference = (value: unknown): value is CardRecord =>
  isRecord(value) && typeof value.document === 'string' && !('status' in value)

/** The human label for a payload field name. */
const fieldLabel = (name: string, t: Translator): string => {
  const label = t(`fields.${name}`)
  // `createTranslator` returns the dot-path when a key is missing. A card type
  // added upstream must still export with readable labels rather than with
  // `answerExport.fields.new_thing`, so an unknown name degrades to itself.
  return label.startsWith('answerExport.fields.') ? humanize(name) : label
}

const humanize = (name: string): string =>
  name.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase())

/**
 * A scalar, as text.
 *
 * Numbers are printed verbatim rather than locale-formatted on purpose: the
 * figure in the document has to be the figure in the answer and in the model,
 * and a decimal separator swapped on the way out is a number the reader cannot
 * match against either.
 */
const scalarText = (value: unknown, t: Translator): string => {
  if (typeof value === 'boolean') return t(value ? 'boolean.true' : 'boolean.false')
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return ''
}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const statusText = (value: unknown, t: Translator): string => {
  if (typeof value !== 'string') return ''
  const label = t(`status.${value}`)
  return label.startsWith('answerExport.status.') ? value : label
}

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
const checkRow = (name: string, check: CardRecord, t: Translator): DocRun[][] => {
  const provenance =
    typeof check.provenance === 'string' ? t(`provenance.${check.provenance}`) : ''
  const qualifier = provenance && !provenance.startsWith('answerExport.') ? ` (${provenance})` : ''
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
    [{ text: (typeof check.label === 'string' && check.label) || fieldLabel(name, t) }],
    [{ text: actual ? `${actual}${qualifier}` : '' }],
    [{ text: required ? `${comparator}${required}` : '' }],
    [{ text: `${statusText(check.status, t)}${missing}` }],
  ]
}

/** Anything nested inside a table cell, flattened to text. */
const nestedText = (value: unknown, t: Translator): string => {
  if (isScalar(value)) return scalarText(value, t)
  if (Array.isArray(value)) return value.map((entry) => nestedText(entry, t)).filter(Boolean).join('; ')
  if (isCheck(value)) {
    const actual = measure(value.value, value.unit)
    const required = measure(value.required, value.unit)
    const comparator = typeof value.comparator === 'string' ? `${value.comparator} ` : ''
    return [actual, required ? `(${comparator}${required})` : '', statusText(value.status, t)]
      .filter(Boolean)
      .join(' ')
  }
  if (isReference(value)) return referenceText(value)
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([key]) => key !== 'type')
      .map(([key, entry]) => `${fieldLabel(key, t)}: ${nestedText(entry, t)}`)
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
const objectTable = (rows: CardRecord[], t: Translator): DocBlock => {
  const keys: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key !== 'type' && !keys.includes(key)) keys.push(key)
    }
  }
  return {
    kind: 'table',
    head: keys.map((key) => fieldLabel(key, t)),
    rows: rows.map((row) =>
      keys.map((key) => [
        { text: key === 'status' ? statusText(row[key], t) : nestedText(row[key], t) },
      ])
    ),
  }
}

/** Accumulates adjacent fields of the same shape so they share one table. */
class CardBody {
  readonly blocks: DocBlock[] = []
  private scalars: DocRun[][][] = []
  private checks: DocRun[][][] = []

  constructor(private readonly t: Translator) {}

  scalar(name: string, value: unknown): void {
    this.flushChecks()
    this.scalars.push([[{ text: fieldLabel(name, this.t) }], [{ text: scalarText(value, this.t) }]])
  }

  check(name: string, value: CardRecord): void {
    this.flushScalars()
    this.checks.push(checkRow(name, value, this.t))
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
      head: [
        fieldLabel('label', this.t),
        fieldLabel('value', this.t),
        fieldLabel('required', this.t),
        fieldLabel('status', this.t),
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
  // Nothing at all — not even the heading. A „Weiterführende Fragen" heading
  // with no questions under it would still put the app's own chrome inside the
  // findings section.
  if (kind === 'chrome') return []

  const heading: DocBlock = { kind: 'heading', level: 3, text: cardHeading(card, type, t) }

  if (kind === 'live') {
    const note = typeof card.note === 'string' ? card.note.trim() : ''
    return compact([
      heading,
      note ? { kind: 'paragraph', runs: [{ text: note }] } : null,
      { kind: 'paragraph', runs: [{ text: t('liveCard') }], style: 'meta' },
    ])
  }

  const body = new CardBody(t)

  for (const name of orderedFields(card, type)) {
    const field = card[name]
    if (field === null || field === undefined) continue

    if (isCheck(field)) {
      body.check(name, field)
      continue
    }

    if (isReference(field)) {
      const text = referenceText(field)
      if (text) body.labelled(fieldLabel(name, t), text)
      const excerpt = typeof field.excerpt === 'string' ? field.excerpt.trim() : ''
      // The literal sentence the value rests on. Quoted, never paraphrased —
      // it is the one part of a card a reviewer checks against the regulation.
      if (excerpt) body.block({ kind: 'paragraph', runs: [{ text: `„${excerpt}“` }], style: 'quote' })
      continue
    }

    if (Array.isArray(field)) {
      if (field.length === 0) continue
      if (field.every((entry) => isScalar(entry))) {
        body.flush()
        body.block({ kind: 'paragraph', runs: [{ text: fieldLabel(name, t), bold: true }] })
        body.block({
          kind: 'bullets',
          items: field.map((entry) => [{ text: scalarText(entry, t) }]),
        })
        continue
      }
      const rows = field.filter(isRecord)
      if (rows.length > 0) {
        body.flush()
        body.block({ kind: 'paragraph', runs: [{ text: fieldLabel(name, t), bold: true }] })
        body.block(objectTable(rows, t))
      }
      continue
    }

    if (isRecord(field)) {
      const text = nestedText(field, t)
      if (text) body.labelled(fieldLabel(name, t), text)
      continue
    }

    if (isScalar(field)) {
      const text = scalarText(field, t)
      if (!text.trim()) continue
      if (text.length > PROSE_LENGTH || text.includes('\n')) {
        body.labelled(fieldLabel(name, t), text)
      } else {
        body.scalar(name, field)
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
