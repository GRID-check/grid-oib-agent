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

/**
 * One storey name, reduced to the form every comparison uses.
 *
 * Three places matched storey names three different ways: this module
 * lowercased without trimming, the rail publishes `name.trim()`, and the
 * elevation lookup used `===`. Both differences bite:
 *
 * - An IFC storey named `' Erdgeschoss '` — trailing whitespace is common in
 *   exports — makes the rail write `?storey=Erdgeschoss` while every element
 *   carries the padded name. Nothing matches, the model DOES assign storeys,
 *   so the answer is an empty set, which the renderer reads as "draw
 *   nothing". The app's own rail blanks the building.
 * - A link carrying `?storey=erdgeschoss` isolates correctly but finds no
 *   elevation, so switching on the cut lands a third of the way up the
 *   building instead of a metre above that floor, and no rail row shows as
 *   selected.
 */
export function storeyKey(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase()
}

/**
 * Express ids of everything on one storey, matched by name (case-insensitive).
 *
 * ## Three answers, and why they are three
 *
 * The renderer reads `isolatedIds` as: `null` — isolate nothing, draw the whole
 * building; an EMPTY set — isolate nothing at all, i.e. draw NOTHING. Those two
 * are one keystroke apart and a whole building apart, so every path out of here
 * has to say which one it means.
 *
 * - **No filter asked for** → `null`. Draw everything.
 * - **A filter that cannot be evaluated** → `null`. The element list arrives
 *   from a separate request than the geometry, so a link carrying `?storey=EG`
 *   renders the building a beat before the rows land. Returning an empty set in
 *   that window blanks the viewport mid-load, which reads as a model that
 *   failed rather than as a list that has not arrived. Same answer when the
 *   model publishes no storey assignments at all: matching by name is
 *   impossible, and hiding the building is not a truthful way to say so.
 * - **A filter that evaluated to nothing** → an empty set. The model DOES
 *   assign elements to storeys and none of them are on this one, so an empty
 *   viewport is the correct answer to the question that was asked.
 */
export function expressIdsForStorey(
  elements: readonly BimViewerElement[],
  storeyName: string | null
): Set<number> | null {
  if (!storeyName) return null
  const needle = storeyKey(storeyName)
  const ids = new Set<number>()
  let anyStoreyAssignment = false
  for (const element of elements) {
    if (element.storeyName) anyStoreyAssignment = true
    if (storeyKey(element.storeyName) === needle) ids.add(element.expressId)
  }
  // Nothing to match against — the rows have not arrived, or this model does
  // not assign elements to storeys. Either way the filter is unanswerable, and
  // an unanswerable filter must not hide the building.
  if (!anyStoreyAssignment) return null
  return ids
}

/**
 * What the viewport is currently showing, once the reader has intervened.
 *
 * Two different acts, and they are not the same act with the sign flipped:
 *
 * - **Hiding** removes the thing in the way. A reviewer hides the roof slab to
 *   see the stair under it, and everything else stays exactly as it was.
 * - **Isolating** removes everything else. A reviewer isolates a stair core to
 *   look at nothing but that, and hiding "everything else" one element at a
 *   time is not a thing a person can do.
 *
 * Both compose with the storey filter rather than replacing it, because a
 * reader who has isolated a stair on the first floor means BOTH constraints —
 * and a control that silently drops one of them is a viewport that shows a
 * different building from the one the chrome describes.
 */
export interface ViewerVisibility {
  /** Manually hidden elements. Empty means nothing has been hidden. */
  hidden: ReadonlySet<number>
  /** Manually isolated elements, or `null` when nothing is isolated. */
  isolated: ReadonlySet<number> | null
}

export const NOTHING_HIDDEN: ViewerVisibility = { hidden: new Set(), isolated: null }

/** Whether the reader has changed what is visible — drives "show everything". */
export function hasVisibilityEdits(visibility: ViewerVisibility): boolean {
  return visibility.hidden.size > 0 || visibility.isolated !== null
}

/**
 * The isolation set the renderer is finally given.
 *
 * The intersection when both a storey filter and a manual isolation are live,
 * because they are two constraints on one question and the reader asked for
 * both. An intersection that comes out EMPTY is meaningful and is passed
 * through: the reader isolated something that is not on the level they are
 * filtering to, and an empty viewport is the honest report of that — quietly
 * dropping one constraint would show them a building they did not ask for and
 * leave both controls looking active.
 */
export function resolveIsolation(
  storeyIds: ReadonlySet<number> | null,
  isolated: ReadonlySet<number> | null
): Set<number> | null {
  if (!storeyIds && !isolated) return null
  if (!storeyIds) return new Set(isolated)
  if (!isolated) return new Set(storeyIds)
  const both = new Set<number>()
  for (const id of isolated) if (storeyIds.has(id)) both.add(id)
  return both
}

/**
 * Hiding the element you are looking at should not leave it selected.
 *
 * The inspector would go on describing a component that is no longer on
 * screen, and the orbit pivot would stay on it — the camera would swing around
 * something invisible.
 */
export function selectionSurvives(
  selectedExpressId: number | null,
  visibility: ViewerVisibility
): boolean {
  if (selectedExpressId === null) return false
  if (visibility.hidden.has(selectedExpressId)) return false
  if (visibility.isolated && !visibility.isolated.has(selectedExpressId)) return false
  return true
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
export function formatElevation(storey: Pick<BimStorey, 'elevation'>, locale: string): string {
  if (storey.elevation === null) return '—'
  const rounded = Math.round(storey.elevation * 100) / 100
  // Locale digits: `+3.25 m` in a German Struktur tree reads as 325 metres.
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString(locale)} m`
}

/** `IfcWall` → `Wall`, for a table column that does not need the prefix. */
export function shortIfcType(ifcType: string): string {
  return ifcType.startsWith('Ifc') ? ifcType.slice(3) : ifcType
}
