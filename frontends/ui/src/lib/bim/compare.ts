/**
 * Revision comparison — what changed between two versions of the same building.
 *
 * ## Why this exists, and why only a model can do it
 *
 * An architect's real question at every submission is not "what is in the
 * model" but "what changed since the version the authority already has". Two
 * PDFs cannot answer it: a plan set redrawn from a changed model looks
 * different everywhere and identical where it matters. Two IFC files can,
 * because IFC gives every element a **GlobalId** that survives export — the
 * same wall in v1 and v3 carries the same id, so "added / removed / changed" is
 * a set operation rather than a visual diff.
 *
 * That makes this the one thing in the product that is strictly impossible on
 * documents, and the reason the extractor treats GlobalId as the element's
 * identity everywhere rather than as one attribute among many.
 *
 * ## What counts as a change
 *
 * Only facts an answer could be built on: which storey an element sits in, what
 * it is called, what type it is, and the property and quantity VALUES.
 * Express ids are excluded deliberately — they are re-assigned on every export,
 * so comparing them would report every element in the building as changed.
 *
 * Pure: a function of two element lists.
 */

import type { BimElement } from './types'

/** One field that differs between the two revisions of one element. */
export interface BimFieldChange {
  /** `storey`, `name`, `Pset_WallCommon.FireRating`, `Qto_…​.NetSideArea`. */
  field: string
  before: string | number | boolean | null
  after: string | number | boolean | null
  /** Signed difference, for numeric fields only. */
  delta: number | null
}

export interface BimChangedElement {
  globalId: string
  ifcType: string
  name: string | null
  storeyName: string | null
  changes: BimFieldChange[]
}

export interface BimElementRef {
  globalId: string
  ifcType: string
  name: string | null
  storeyName: string | null
}

export interface BimComparison {
  added: BimElementRef[]
  removed: BimElementRef[]
  changed: BimChangedElement[]
  /** Elements present in both revisions with no compared field different. */
  unchangedCount: number
  totals: { base: number; revision: number }
  /**
   * Set when either side was capped: the comparison then covers the elements
   * that were indexed, and a missing element may be a cap rather than a
   * deletion. Nothing downstream may present a truncated diff as complete.
   */
  truncated: boolean
}

/** How many elements each bucket reports before it stops listing them. */
export const MAX_COMPARISON_ROWS = 500

function ref(element: BimElement): BimElementRef {
  return {
    globalId: element.globalId,
    ifcType: element.ifcType,
    name: element.name,
    storeyName: element.storeyName,
  }
}

/** Flatten property + quantity sets into one comparable `set.name` map. */
function flatten(element: BimElement): Map<string, string | number | boolean | null> {
  const flat = new Map<string, string | number | boolean | null>()
  for (const [setName, properties] of Object.entries(element.properties)) {
    for (const [name, value] of Object.entries(properties)) flat.set(`${setName}.${name}`, value)
  }
  for (const [setName, quantities] of Object.entries(element.quantities)) {
    for (const [name, value] of Object.entries(quantities)) flat.set(`${setName}.${name}`, value)
  }
  return flat
}

function numericDelta(
  before: string | number | boolean | null,
  after: string | number | boolean | null
): number | null {
  if (typeof before !== 'number' || typeof after !== 'number') return null
  // Rounded like every other measure in this subsystem, so a float artefact
  // does not render as a change of 0.0000000001.
  return Math.round((after - before) * 10_000) / 10_000
}

/** Identity fields worth reporting, in the order a reader scans them. */
const IDENTITY_FIELDS: Array<{ field: string; read: (element: BimElement) => string | null }> = [
  { field: 'ifcType', read: (element) => element.ifcType },
  { field: 'name', read: (element) => element.name },
  { field: 'storey', read: (element) => element.storeyName },
  { field: 'predefinedType', read: (element) => element.predefinedType },
  { field: 'typeName', read: (element) => element.typeName },
  { field: 'materials', read: (element) => (element.materials.length ? element.materials.join(', ') : null) },
]

function diffElement(before: BimElement, after: BimElement): BimFieldChange[] {
  const changes: BimFieldChange[] = []

  for (const { field, read } of IDENTITY_FIELDS) {
    const from = read(before)
    const to = read(after)
    if (from !== to) changes.push({ field, before: from, after: to, delta: null })
  }

  const beforeFlat = flatten(before)
  const afterFlat = flatten(after)
  // Union of both key sets: a property that DISAPPEARED between revisions is as
  // much a change as one whose value moved, and reporting only the survivors
  // would hide a wall that lost its fire rating.
  const keys = new Set([...beforeFlat.keys(), ...afterFlat.keys()])
  for (const key of [...keys].sort()) {
    const from = beforeFlat.has(key) ? (beforeFlat.get(key) ?? null) : null
    const to = afterFlat.has(key) ? (afterFlat.get(key) ?? null) : null
    if (from === to) continue
    changes.push({ field: key, before: from, after: to, delta: numericDelta(from, to) })
  }

  return changes
}

/**
 * Compare two revisions of a model, matched by IFC GlobalId.
 *
 * `base` is the older revision and `revision` the newer one, so "added" means
 * present in the newer file. Getting that order wrong inverts every finding, so
 * callers name the arguments rather than positioning them by convention.
 */
export function compareModels(input: {
  base: readonly BimElement[]
  revision: readonly BimElement[]
  truncated?: boolean
}): BimComparison {
  const baseById = new Map(input.base.map((element) => [element.globalId, element]))
  const revisionById = new Map(input.revision.map((element) => [element.globalId, element]))

  const added: BimElementRef[] = []
  const removed: BimElementRef[] = []
  const changed: BimChangedElement[] = []
  let unchangedCount = 0

  for (const element of input.revision) {
    const previous = baseById.get(element.globalId)
    if (!previous) {
      added.push(ref(element))
      continue
    }
    const changes = diffElement(previous, element)
    if (changes.length === 0) {
      unchangedCount += 1
      continue
    }
    changed.push({ ...ref(element), changes })
  }

  for (const element of input.base) {
    if (!revisionById.has(element.globalId)) removed.push(ref(element))
  }

  const byType = (a: BimElementRef, b: BimElementRef) =>
    a.ifcType === b.ifcType
      ? (a.name ?? '').localeCompare(b.name ?? '')
      : a.ifcType.localeCompare(b.ifcType)

  return {
    added: added.sort(byType).slice(0, MAX_COMPARISON_ROWS),
    removed: removed.sort(byType).slice(0, MAX_COMPARISON_ROWS),
    // Most-changed first: an element with six differing properties is the one
    // worth reading about, and a list sorted by name buries it.
    changed: changed
      .sort((a, b) => b.changes.length - a.changes.length)
      .slice(0, MAX_COMPARISON_ROWS),
    unchangedCount,
    totals: { base: input.base.length, revision: input.revision.length },
    truncated: input.truncated ?? false,
  }
}

/** One-line German summary the agent can quote without recomputing anything. */
export function renderComparison(comparison: BimComparison): string {
  const { added, removed, changed, unchangedCount } = comparison
  // The truncation note is appended to EVERY outcome, including "no
  // differences". A clean comparison over a partially indexed model is the most
  // dangerous sentence this function can produce — it reads as "nothing
  // changed" when it means "nothing changed in the part we looked at".
  const truncated = comparison.truncated
    ? ' Achtung: mindestens ein Stand ist gekürzt indiziert, der Vergleich kann unvollständig sein.'
    : ''

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return `Keine Unterschiede: beide Stände enthalten dieselben ${unchangedCount} Bauteile mit gleichen Werten.${truncated}`
  }
  const parts = [
    `${added.length} neu`,
    `${removed.length} entfallen`,
    `${changed.length} geändert`,
    `${unchangedCount} unverändert`,
  ]
  return `Vergleich: ${parts.join(', ')}.${truncated}`
}
