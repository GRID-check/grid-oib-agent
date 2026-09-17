/**
 * The structured visual analysis, normalized for display.
 *
 * The backend stores the whole analysis on each visual chunk and hands it back
 * on `/visual-details` as `structured`. It is produced by a vision model
 * against a versioned, domain-neutral schema
 * (`sources/knowledge_layer/src/llamaindex/visual_analysis.py`) whose
 * vocabulary comes from pluggable domains (`.../visual_domains.py`). This
 * module is the boundary that turns it into something the UI can render
 * WITHOUT knowing any domain: unknown keys are dropped, every field is
 * defaulted, and nothing here throws on a malformed payload.
 *
 * The extensibility rule this file has to honour: adding a domain on the
 * backend must not require a change here. So entities are grouped by whatever
 * category key they carry, and a category this build has never heard of is
 * rendered from its key rather than dropped — a new domain degrades to a
 * readable label instead of disappearing.
 */

export interface StructuredEntity {
  name: string
  category: string
  role: string | null
  measure: string | null
}

export interface StructuredLayer {
  material: string
  thickness: string | null
  purpose: string | null
}

export interface StructuredComposition {
  component: string
  layers: StructuredLayer[]
}

export interface StructuredState {
  element: string
  state: string
}

export interface StructuredQuantity {
  object: string
  property: string
  value: string
  unit: string | null
  source: string | null
  confidence: string | null
}

export interface StructuredRelation {
  subject: string
  relation: string
  object: string
}

/** Entities of one category, ready to render as a single labelled line. */
export interface StructuredEntityGroup {
  category: string
  entities: StructuredEntity[]
}

export interface StructuredSegment {
  domain: string
  segmentType: string
  title: string | null
  scale: string | null
  summary: string
  entityGroups: StructuredEntityGroup[]
  compositions: StructuredComposition[]
  states: StructuredState[]
  quantities: StructuredQuantity[]
  relations: StructuredRelation[]
  annotations: string[]
  source: string | null
  confidence: string | null
}

export interface StructuredDocument {
  title: string | null
  subtitle: string | null
  slogans: string[]
  author: string | null
  institution: string | null
  supervision: string | null
  location: string | null
  strategies: string[]
  processSteps: string[]
}

export interface DrawingStructured {
  schemaVersion: number
  /** Vocabulary that produced this, as `domains@contentHash`. */
  registry: string
  segment: StructuredSegment
  document: StructuredDocument
}

type Raw = Record<string, unknown>

const asRecord = (value: unknown): Raw =>
  typeof value === 'object' && value !== null ? (value as Raw) : {}

const asText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * A string-only read, for the fields that are vocabulary terms rather than
 * values. `asText` coerces a number because a model legitimately answers
 * `"value": 71` — but a numeric `category` is not a category, and coercing it
 * would put "42" where a term belongs.
 */
const asTerm = (value: unknown): string | null => (typeof value === 'string' ? asText(value) : null)

const asTextList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asText).filter((entry): entry is string => entry !== null) : []

const asRecordList = (value: unknown): Raw[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is Raw => typeof entry === 'object' && entry !== null)
    : []

/**
 * `building_physics` → `Building physics`. The readable fallback for a
 * category this build has no label for, which is exactly what a domain added
 * on the backend after this build shipped will produce.
 */
export function humanizeTerm(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key
}

function groupEntities(value: unknown): StructuredEntityGroup[] {
  const groups = new Map<string, StructuredEntity[]>()
  for (const raw of asRecordList(value)) {
    const name = asText(raw.name)
    if (!name) continue
    const category = asTerm(raw.category) ?? 'other'
    const entity: StructuredEntity = {
      name,
      category,
      role: asText(raw.role),
      measure: asText(raw.measure),
    }
    const existing = groups.get(category)
    if (existing) existing.push(entity)
    else groups.set(category, [entity])
  }
  return [...groups.entries()].map(([category, entities]) => ({ category, entities }))
}

function normalizeSegment(raw: Raw): StructuredSegment {
  return {
    domain: asTerm(raw.domain) ?? 'general',
    segmentType: asTerm(raw.segment_type) ?? 'other',
    title: asText(raw.title),
    scale: asText(raw.scale),
    summary: asText(raw.summary) ?? '',
    entityGroups: groupEntities(raw.entities),
    compositions: asRecordList(raw.compositions)
      .map((composition) => ({
        component: asText(composition.component) ?? '',
        // `function` is a reserved word in enough contexts to be worth
        // renaming once, here, rather than at every use site.
        layers: asRecordList(composition.layers)
          .map((layer) => ({
            material: asText(layer.material) ?? '',
            thickness: asText(layer.thickness),
            purpose: asText(layer.function),
          }))
          .filter((layer) => layer.material !== ''),
      }))
      .filter((composition) => composition.component !== '' || composition.layers.length > 0),
    states: asRecordList(raw.states)
      .map((entry) => ({
        element: asText(entry.element) ?? '',
        state: asTerm(entry.state) ?? '',
      }))
      .filter((entry) => entry.element !== '' && entry.state !== ''),
    quantities: asRecordList(raw.quantities)
      .map((quantity) => ({
        object: asText(quantity.object) ?? '',
        property: asText(quantity.property) ?? '',
        value: asText(quantity.value) ?? '',
        unit: asText(quantity.unit),
        source: asTerm(quantity.source),
        confidence: asTerm(quantity.confidence),
      }))
      // A number with no object is the "71 %" the schema exists to prevent.
      .filter((quantity) => quantity.object !== '' && quantity.value !== ''),
    relations: asRecordList(raw.relations)
      .map((relation) => ({
        subject: asText(relation.subject) ?? '',
        relation: asText(relation.relation) ?? '',
        object: asText(relation.object) ?? '',
      }))
      .filter((entry) => entry.subject !== '' && entry.relation !== '' && entry.object !== ''),
    annotations: asTextList(raw.annotations),
    source: asTerm(raw.source),
    confidence: asTerm(raw.confidence),
  }
}

function normalizeDocument(raw: Raw): StructuredDocument {
  return {
    title: asText(raw.title),
    subtitle: asText(raw.subtitle),
    slogans: asTextList(raw.slogans),
    author: asText(raw.author),
    institution: asText(raw.institution),
    supervision: asText(raw.supervision),
    location: asText(raw.location),
    strategies: asTextList(raw.strategies),
    processSteps: asTextList(raw.process_steps),
  }
}

/**
 * Normalize one chunk's `structured` payload, or `null` when there is nothing
 * worth showing. Chunks written before the structured schema carry no payload
 * at all, so `null` is the ordinary case for an older corpus — the caller
 * shows the free-text description alone.
 */
export function normalizeDrawingStructured(value: unknown): DrawingStructured | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Raw
  const segmentRaw = asRecord(raw.segment)
  if (Object.keys(segmentRaw).length === 0) return null

  return {
    schemaVersion: typeof raw.schema_version === 'number' ? raw.schema_version : 0,
    registry: asText(raw.registry) ?? '',
    segment: normalizeSegment(segmentRaw),
    document: normalizeDocument(asRecord(raw.document)),
  }
}

/**
 * Whether a normalized payload carries anything BEYOND what the free-text
 * description already says. The description is rendered from the same fields,
 * so a segment with only a summary would make the advanced section an empty
 * disclosure inviting a pointless click.
 */
export function hasStructuredDetail(structured: DrawingStructured | null): boolean {
  if (!structured) return false
  const { segment, document } = structured
  return (
    segment.entityGroups.length > 0 ||
    segment.compositions.length > 0 ||
    segment.states.length > 0 ||
    segment.quantities.length > 0 ||
    segment.relations.length > 0 ||
    segment.annotations.length > 0 ||
    segment.source !== null ||
    segment.confidence !== null ||
    document.title !== null ||
    document.author !== null ||
    document.institution !== null ||
    document.supervision !== null ||
    document.location !== null ||
    document.strategies.length > 0 ||
    document.processSteps.length > 0 ||
    document.slogans.length > 0
  )
}
