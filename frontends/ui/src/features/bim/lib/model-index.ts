/**
 * Pure helpers over a model's summary and element rows.
 *
 * The renderer addresses geometry by STEP `expressId`; every other surface —
 * the agent, the cards, the API — addresses elements by IFC `GlobalId`, because
 * that is the only identifier stable across exports. Translating between the
 * two, and deciding which elements a storey filter or a highlight covers, is
 * the whole job of this module.
 *
 * Kept free of React and of the viewer so it can be tested as a function of its
 * inputs (see `AGENTS.md` on logic living in modules rather than in a render
 * function).
 */

import type { BimSpatialNode, BimStorey } from '@/lib/bim/types'

/** Verdict a highlight carries, mirroring the card's `status`. */
export type BimHighlightStatus = 'pass' | 'fail' | 'warning' | 'info'

export const BIM_HIGHLIGHT_STATUSES: readonly BimHighlightStatus[] = [
  'pass',
  'fail',
  'warning',
  'info',
]

/** One element as the viewer surfaces it — enough to select, label and locate. */
export interface BimViewerElement {
  globalId: string
  expressId: number
  ifcType: string
  name: string | null
  storeyName: string | null
  tag?: string | null
  predefinedType?: string | null
}

export interface BimHighlightGroup {
  globalIds: string[]
  label: string
  status: BimHighlightStatus
}

/**
 * A highlight resolved against the model: the express ids the renderer can
 * colour, plus the ids that matched nothing.
 *
 * `unresolved` is not a diagnostic detail — it is shown. A card that highlights
 * three walls and silently colours two is a wrong answer rendered confidently;
 * saying "1 of 3 elements not found in this model" is a correct one.
 */
export interface ResolvedHighlight extends BimHighlightGroup {
  expressIds: number[]
  unresolved: string[]
}

/** RGBA in 0..1, the renderer's colour-override format. */
export type Rgba = [number, number, number, number]

/**
 * Highlight colours.
 *
 * Deliberately hard-coded rather than read from CSS custom properties: these
 * values go to the GPU as floats, `getComputedStyle` is not available at the
 * point the override map is built, and a semantic token resolved at the wrong
 * moment yields transparent black — an element that vanishes instead of one
 * that is highlighted. They match the feedback token family by eye and are
 * pinned by a test so a redesign updates both together.
 */
export const HIGHLIGHT_RGBA: Record<BimHighlightStatus, Rgba> = {
  pass: [0.13, 0.66, 0.37, 1],
  fail: [0.86, 0.21, 0.27, 1],
  warning: [0.94, 0.66, 0.13, 1],
  info: [0.16, 0.47, 0.93, 1],
}

/** CSS colour for the legend chip beside each highlight group. */
export const HIGHLIGHT_CSS: Record<BimHighlightStatus, string> = {
  pass: 'rgb(33 168 94)',
  fail: 'rgb(219 54 69)',
  warning: 'rgb(240 168 33)',
  info: 'rgb(41 120 237)',
}

/**
 * Whether this browser can run the 3D viewport at all.
 *
 * A per-BROWSER fact checked at render time, not a deployment capability: the
 * same build serves a Chrome user (WebGPU) and a Safari 17 user (not yet), and
 * the second must get the data explorer rather than a blank canvas. Written
 * defensively because it also runs during SSR, where `navigator` is absent.
 */
export function supportsWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu)
}

/** GlobalId → expressId, for translating agent/card ids into renderer ids. */
export function buildExpressIdIndex(
  elements: readonly BimViewerElement[]
): Map<string, number> {
  const index = new Map<string, number>()
  for (const element of elements) index.set(element.globalId, element.expressId)
  return index
}

/** expressId → element, for turning a viewport pick into something readable. */
export function buildElementIndex(
  elements: readonly BimViewerElement[]
): Map<number, BimViewerElement> {
  const index = new Map<number, BimViewerElement>()
  for (const element of elements) index.set(element.expressId, element)
  return index
}

/** Resolve a card's highlight groups against the loaded model. */
export function resolveHighlights(
  groups: readonly BimHighlightGroup[],
  elements: readonly BimViewerElement[]
): ResolvedHighlight[] {
  const byGlobalId = buildExpressIdIndex(elements)
  return groups.map((group) => {
    const expressIds: number[] = []
    const unresolved: string[] = []
    for (const globalId of group.globalIds) {
      const expressId = byGlobalId.get(globalId)
      if (expressId === undefined) unresolved.push(globalId)
      else expressIds.push(expressId)
    }
    return { ...group, expressIds, unresolved }
  })
}

/**
 * The colour-override map the renderer takes.
 *
 * Later groups win on overlap, matching the reading order of the legend: an
 * element listed under both "checked" and "fails the clearance" should show as
 * failing, and the failing group is the one an author writes second.
 */
export function buildColorOverrides(
  highlights: readonly ResolvedHighlight[]
): Map<number, Rgba> {
  const overrides = new Map<number, Rgba>()
  for (const highlight of highlights) {
    const colour = HIGHLIGHT_RGBA[highlight.status]
    for (const expressId of highlight.expressIds) overrides.set(expressId, colour)
  }
  return overrides
}

/** Every express id named by any highlight, for framing the camera on them. */
export function highlightedExpressIds(highlights: readonly ResolvedHighlight[]): Set<number> {
  const ids = new Set<number>()
  for (const highlight of highlights) for (const id of highlight.expressIds) ids.add(id)
  return ids
}

/** Express ids of everything on one storey, matched by name (case-insensitive). */
export function expressIdsForStorey(
  elements: readonly BimViewerElement[],
  storeyName: string | null
): Set<number> | null {
  if (!storeyName) return null
  const needle = storeyName.toLowerCase()
  const ids = new Set<number>()
  for (const element of elements) {
    if ((element.storeyName ?? '').toLowerCase() === needle) ids.add(element.expressId)
  }
  return ids
}

export interface SpatialTreeRow {
  key: string
  depth: number
  label: string
  ifcType: string
  elementCount: number
  /** Storey elevation in metres, for the one node kind that has one. */
  elevation: number | null
  /** Storey name this row filters to, or null for a non-storey node. */
  storeyName: string | null
}

/**
 * Flatten the spatial tree into rows for a list.
 *
 * A flat list with a depth column rather than a nested component: the tree is
 * at most five levels deep by construction (project → site → building → storey
 * → space), and a flat list is trivially virtualizable and keyboard-navigable,
 * which a recursive render is not.
 */
export function flattenSpatialTree(node: BimSpatialNode | null): SpatialTreeRow[] {
  if (!node) return []
  const rows: SpatialTreeRow[] = []
  const visit = (current: BimSpatialNode, depth: number, storeyName: string | null) => {
    const isStorey = current.ifcType === 'IfcBuildingStorey'
    const inheritedStorey = isStorey ? current.name : storeyName
    rows.push({
      key: current.globalId ?? `express:${current.expressId}`,
      depth,
      label: current.name ?? current.ifcType,
      ifcType: current.ifcType,
      elementCount: current.elementCount,
      elevation: current.elevation,
      storeyName: isStorey ? current.name : null,
    })
    for (const child of current.children) visit(child, depth + 1, inheritedStorey)
  }
  visit(node, 0, null)
  return rows
}

/** Format a storey's elevation for display, or `—` when it has none. */
export function formatElevation(storey: Pick<BimStorey, 'elevation'>): string {
  if (storey.elevation === null) return '—'
  const rounded = Math.round(storey.elevation * 100) / 100
  return `${rounded > 0 ? '+' : ''}${rounded} m`
}

/** `IfcWall` → `Wall`, for a table column that does not need the prefix. */
export function shortIfcType(ifcType: string): string {
  return ifcType.startsWith('Ifc') ? ifcType.slice(3) : ifcType
}
