/**
 * The one place a card's highlight payload becomes something typed.
 *
 * ## Why this file exists at all
 *
 * `scripts/generate-card-schemas.mjs` emits a nested `$ref` as `z.any()`, so
 * `ifcViewerCardSchema.highlights` infers as `any[]` and every field read off a
 * highlight is unchecked. That is the drift the repo's `any` rule exists to
 * stop: the payload could lose a field and nothing would fail until a user saw
 * an empty viewport. Rather than sprinkle assertions at the call site, the wire
 * shape is written out ONCE here, next to the conversion that consumes it.
 *
 * ## Why a conversion is needed
 *
 * The card is authored in Python and carries `snake_case`; the BIM query API
 * this filter is replayed against speaks `camelCase` (`lib/bim/query.ts`
 * `bimFilterSchema`). They are the same grammar with two spellings, and the
 * translation belongs here rather than in either schema — renaming the Python
 * fields would make the card read wrong to the agent writing it, and renaming
 * the query fields would break every other caller.
 *
 * Unknown keys are dropped rather than forwarded. The endpoint validates
 * strictly and would reject the whole query, which would blank a highlight
 * group over a field the model invented — losing the four it got right.
 */

import type { BimHighlightSpec } from '../hooks/use-bim-model'
import type { BimHighlightStatus } from './model-index'

const STATUSES: readonly BimHighlightStatus[] = ['pass', 'fail', 'warning', 'info']

/** A property predicate as the card carries it. */
interface PropertyMatchPayload {
  name?: unknown
  set?: unknown
  operator?: unknown
  value?: unknown
  source?: unknown
}

/** A highlight group as the card carries it — `snake_case`, all optional. */
export interface HighlightPayload {
  global_ids?: unknown
  match?: unknown
  label?: unknown
  status?: unknown
}

/**
 * Closed enums in the card schema, and therefore in the query grammar too.
 *
 * Forwarding an unrecognised value would defeat the point of this module:
 * `operator: 'like'` is rejected by the endpoint just as hard as an invented
 * KEY is, and it takes the whole filter — and so the whole highlight group —
 * with it. Dropping it narrows the predicate instead, which the group survives.
 */
const OPERATORS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing'] as const
const SOURCES = ['property', 'quantity'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const strings = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return strings.length > 0 ? strings : undefined
}

/**
 * The trimmed value, or `undefined` when nothing is left.
 *
 * Trimmed on the way OUT as well as on the way in: returning the padded string
 * after testing the trimmed one made `nameContains: ' AW '` a substring match
 * on the spaces too, matching fewer elements than the author meant, and put
 * the padding in the rendered legend label.
 */
const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A closed-enum field: the value if it is one of them, else `undefined`. */
const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  allowed.find((candidate) => candidate === value)

/** Either spelling of a key — see the note on `matchToFilter`. */
const either = (raw: Record<string, unknown>, snake: string, camel: string): unknown =>
  raw[snake] !== undefined ? raw[snake] : raw[camel]

function propertyFilter(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null
  const name = nonEmpty(raw.name)
  // A predicate with no property name matches nothing in particular; forwarding
  // it would be rejected by the endpoint and take the whole group with it.
  if (!name) return null
  const filter: Record<string, unknown> = { name }
  const set = nonEmpty((raw as PropertyMatchPayload).set)
  if (set) filter.set = set
  const operator = oneOf(OPERATORS, raw.operator)
  if (operator) filter.operator = operator
  if (typeof raw.value === 'string' || typeof raw.value === 'number' || typeof raw.value === 'boolean') {
    filter.value = raw.value
  }
  const source = oneOf(SOURCES, raw.source)
  if (source) filter.source = source
  return filter
}

/**
 * The card's `match` object as the query API's filter, or `null`.
 *
 * `null` for a match that carries no usable criterion — an empty filter means
 * "every element in the building", which would highlight the whole model under
 * a label like *fails the clearance*.
 */
export function matchToFilter(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null
  const filter: Record<string, unknown> = {}

  // Both spellings are read. The card model normalises `ifcTypes` to
  // `ifc_types` on the way in, but a card stored before those aliases existed
  // carries whichever the agent wrote, and a message is replayed from storage
  // long after the schema moved on.
  const ifcTypes = stringList(either(raw, 'ifc_types', 'ifcTypes'))
  if (ifcTypes) filter.ifcTypes = ifcTypes
  const storeys = stringList(raw.storeys)
  if (storeys) filter.storeys = storeys
  const nameContains = nonEmpty(either(raw, 'name_contains', 'nameContains'))
  if (nameContains) filter.nameContains = nameContains
  const material = nonEmpty(raw.material)
  if (material) filter.material = material
  const classification = nonEmpty(raw.classification)
  if (classification) filter.classification = classification

  if (Array.isArray(raw.properties)) {
    const properties = raw.properties.map(propertyFilter).filter((entry): entry is Record<string, unknown> => entry !== null)
    if (properties.length > 0) filter.properties = properties
  }

  return Object.keys(filter).length > 0 ? filter : null
}

/**
 * Turn a card's highlight array into specs the viewer hooks understand.
 *
 * A group that carries neither a usable filter nor any id is dropped: the
 * legend would otherwise name a group that can never colour anything, which
 * reads as "nothing matched" rather than "this was malformed".
 */
export function cardHighlightSpecs(payload: readonly HighlightPayload[]): BimHighlightSpec[] {
  const specs: BimHighlightSpec[] = []
  for (const group of payload) {
    const label = nonEmpty(group.label)
    if (!label) continue
    const status = STATUSES.find((candidate) => candidate === group.status) ?? 'info'
    // `global_ids` wins when both are present. The Python model refuses that
    // combination, but this side must not depend on the other side's
    // validation having run — a card can also arrive from a stored message.
    const globalIds = stringList(group.global_ids)
    if (globalIds) {
      specs.push({ globalIds, label, status })
      continue
    }
    const match = matchToFilter(group.match)
    if (match) specs.push({ match, label, status })
  }
  return specs
}
