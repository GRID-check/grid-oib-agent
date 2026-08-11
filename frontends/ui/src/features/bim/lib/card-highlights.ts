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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((entry): entry is string => typeof entry === 'string')
  return strings.length > 0 ? strings : undefined
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

function propertyFilter(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null
  const name = nonEmpty(raw.name)
  // A predicate with no property name matches nothing in particular; forwarding
  // it would be rejected by the endpoint and take the whole group with it.
  if (!name) return null
  const filter: Record<string, unknown> = { name }
  const set = nonEmpty((raw as PropertyMatchPayload).set)
  if (set) filter.set = set
  const operator = nonEmpty(raw.operator)
  if (operator) filter.operator = operator
  if (typeof raw.value === 'string' || typeof raw.value === 'number' || typeof raw.value === 'boolean') {
    filter.value = raw.value
  }
  const source = nonEmpty(raw.source)
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

  const ifcTypes = stringList(raw.ifc_types)
  if (ifcTypes) filter.ifcTypes = ifcTypes
  const storeys = stringList(raw.storeys)
  if (storeys) filter.storeys = storeys
  const nameContains = nonEmpty(raw.name_contains)
  if (nameContains) filter.nameContains = nameContains
  const material = nonEmpty(raw.material)
  if (material) filter.material = material

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
