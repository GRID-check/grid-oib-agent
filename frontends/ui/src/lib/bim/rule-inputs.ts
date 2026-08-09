/**
 * The slice of a model the rule catalogue actually reads.
 *
 * ## The problem this exists to remove
 *
 * `loadBimElementsForSchedule` does `db.select()` — every column, including
 * the whole `properties` and `quantities` jsonb. Measured on a seeded
 * 400 000-element model: ~1 199 bytes per row, so a 50 000-row compliance load
 * ships roughly **60 MB of JSON text**. Postgres finds those rows in ~450 ms
 * on an index scan; the other ~900 ms of a 1.5 s request is the driver
 * parsing that JSON **on the single-threaded event loop**, during which the
 * pod serves nobody. The rules then read thirteen keys out of it and discard
 * the rest.
 *
 * ## What is stored instead
 *
 * A pruned copy of the same elements — six fields, and only the property and
 * quantity keys below — computed ONCE when extraction completes and kept on
 * the model row. Measured on a realistic wall row: **1 409 → 219 bytes per
 * element**, so a 50 000-element load is 11 MB instead of 70 MB and parses in
 * ~55 ms instead of ~580 ms, arriving as a single column of a single row.
 *
 * The projection is deliberately a `BimElement[]` and not a new shape. Every
 * rule keeps reading `element.properties[set][key]` exactly as before, so the
 * catalogue is unchanged and cannot drift from what is stored — the pruning is
 * invisible to it, which is the only way this stays safe as rules are added.
 *
 * ## Keeping it honest as rules change
 *
 * A rule that starts reading a key not listed here would silently see
 * `undefined` on the fast path and the real value on the slow one — the same
 * value read two different ways, which is the worst kind of bug to chase.
 * `rules.spec.ts` therefore asserts that every key the catalogue reads appears
 * in {@link RULE_INPUT_KEYS}, so adding a rule that needs a new one fails the
 * suite rather than the building.
 */

import type { BimElement, BimPropertySets, BimQuantitySets } from './types'

/**
 * Element FIELDS the catalogue reads directly, outside `properties` and
 * `quantities`.
 *
 * `predefinedType` is the one that bit: the door rule reads
 * `element.predefinedType` rather than going through a Pset, so a projection
 * that nulled it turned every door into a different verdict on the fast path.
 * The equivalence test caught it; this list is here so the next one is caught
 * by reading rather than by luck.
 */
export const RULE_INPUT_FIELDS: readonly string[] = [
  'globalId',
  'ifcType',
  'name',
  'storeyName',
  'predefinedType',
  'properties',
  'quantities',
]

/**
 * Every property and quantity key any rule in the catalogue reads.
 *
 * Matched case-insensitively, because the set and key names come from
 * whichever tool exported the model — the same reason the query layer uses
 * `lower()` on both sides.
 */
export const RULE_INPUT_KEYS: readonly string[] = [
  'AcousticRating',
  'ClearHeight',
  'ClearWidth',
  'FinishCeilingHeight',
  'FireRating',
  'Height',
  'IsExternal',
  'LoadBearing',
  'OverallWidth',
  'RiserHeight',
  'ThermalTransmittance',
  'TreadLength',
  'Width',
]

const WANTED = new Set(RULE_INPUT_KEYS.map((key) => key.toLowerCase()))

function prune<T extends BimPropertySets | BimQuantitySets>(sets: T): T {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [setName, values] of Object.entries(sets)) {
    let kept: Record<string, unknown> | undefined
    for (const [key, value] of Object.entries(values)) {
      if (!WANTED.has(key.toLowerCase())) continue
      kept ??= {}
      kept[key] = value
    }
    // An empty set is dropped entirely rather than kept as `{}`: the rules
    // iterate `Object.values(properties)`, so empty sets are pure overhead.
    if (kept) out[setName] = kept
  }
  return out as T
}

/**
 * Project elements down to what the catalogue reads.
 *
 * Materials and classifications are dropped — no rule reads them — as are
 * `expressId`, `tag`, `typeName` and the rest of the identity fields the
 * verdicts never render. `globalId`, `name`, `ifcType` and `storeyName` stay,
 * because every verdict names the element and OIB 2 Tabelle 1b needs the
 * storey.
 */
/**
 * One element, in the shape that is stored.
 *
 * Single-letter keys, and absent rather than null when empty. That reads as
 * over-optimisation until you count: a `BimElement` has thirteen fields no
 * rule touches, and writing them as `"description":null,"objectType":null,…`
 * spends ~260 bytes PER ELEMENT on key names for values nobody reads — more
 * than the payload itself. At 50 000 elements that is 13 MB of punctuation.
 *
 * It never escapes this module: {@link readStoredRuleInputs} rehydrates full
 * `BimElement`s, so the catalogue is unchanged and cannot drift from what is
 * stored.
 */
interface CompactElement {
  /** globalId */
  g: string
  /** ifcType */
  t: string
  /** name */
  n?: string
  /** storeyName */
  s?: string
  /** predefinedType — read directly by the door rule, not via a Pset. */
  d?: string
  /** properties */
  p?: BimPropertySets
  /** quantities */
  q?: BimQuantitySets
}

const hasEntries = (sets: BimPropertySets | BimQuantitySets): boolean =>
  Object.keys(sets).length > 0

export function projectRuleInputs(elements: readonly BimElement[]): CompactElement[] {
  return elements.map((element) => {
    const properties = prune(element.properties)
    const quantities = prune(element.quantities)
    const compact: CompactElement = { g: element.globalId, t: element.ifcType }
    if (element.name !== null) compact.n = element.name
    if (element.storeyName !== null) compact.s = element.storeyName
    if (element.predefinedType !== null) compact.d = element.predefinedType
    if (hasEntries(properties)) compact.p = properties
    if (hasEntries(quantities)) compact.q = quantities
    return compact
  })
}

/** Back to what the catalogue expects, so no rule knows this happened. */
function rehydrate(compact: CompactElement): BimElement {
  return {
    globalId: compact.g,
    expressId: 0,
    ifcType: compact.t,
    name: compact.n ?? null,
    description: null,
    predefinedType: compact.d ?? null,
    objectType: null,
    tag: null,
    typeName: null,
    storeyGlobalId: null,
    storeyName: compact.s ?? null,
    containerGlobalId: null,
    containerKind: null,
    containerName: null,
    materials: [],
    classifications: [],
    properties: compact.p ?? {},
    quantities: compact.q ?? {},
  }
}

/** What is kept alongside the pruned elements, so a reader can trust them. */
export interface StoredRuleInputs {
  /** Schema of this projection; a mismatch falls back to the full load. */
  version: number
  /** The element loader capped when this was computed. */
  truncated: boolean
  elements: CompactElement[]
}

/**
 * Bumped whenever {@link RULE_INPUT_KEYS} or the pruning changes.
 *
 * A stored projection written before a new key was added does not contain it,
 * and serving it would answer with `undefined` where the model has a value.
 * The version makes that a cache miss instead of a wrong verdict.
 */
export const RULE_INPUTS_VERSION = 1

export function buildStoredRuleInputs(
  elements: readonly BimElement[],
  truncated: boolean
): StoredRuleInputs {
  return { version: RULE_INPUTS_VERSION, truncated, elements: projectRuleInputs(elements) }
}

/** Read a stored projection back, or `null` when it cannot be trusted. */
export function readStoredRuleInputs(
  raw: unknown
): { truncated: boolean; elements: BimElement[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<StoredRuleInputs>
  // A projection written before a key was added does not contain it, and
  // serving it would answer `undefined` where the model has a value.
  if (value.version !== RULE_INPUTS_VERSION) return null
  if (!Array.isArray(value.elements)) return null
  return { truncated: value.truncated === true, elements: value.elements.map(rehydrate) }
}

/**
 * The flat lowercased lookup map the GIN pre-filter reads.
 *
 * Mirrors the backfill in `0038_bim_element_search_keys.sql` exactly — the two
 * must agree, or a freshly extracted model and a backfilled one answer the
 * same filter differently. Both emit the bare key (any set) and the
 * set-qualified key, prefixed `p:` for properties and `q:` for quantities.
 */
export function buildSearchKeys(element: BimElement): Record<string, string[]> {
  const keys = new Map<string, Set<string>>()
  const add = (key: string, value: string): void => {
    const bucket = keys.get(key) ?? new Set<string>()
    bucket.add(value)
    keys.set(key, bucket)
  }

  for (const [prefix, sets] of [
    ['p:', element.properties],
    ['q:', element.quantities],
  ] as const) {
    for (const [setName, values] of Object.entries(sets)) {
      for (const [name, raw] of Object.entries(values)) {
        // `#>> '{}'` in SQL renders a jsonb scalar as text; `String()` is the
        // JS equivalent for the same scalar types, and `null` is skipped on
        // both sides.
        if (raw === null || raw === undefined) continue
        const value = String(raw).toLowerCase()
        add(`${prefix}${name.toLowerCase()}`, value)
        add(`${prefix}${setName.toLowerCase()}.${name.toLowerCase()}`, value)
      }
    }
  }
  return Object.fromEntries([...keys].map(([key, values]) => [key, [...values]]))
}
