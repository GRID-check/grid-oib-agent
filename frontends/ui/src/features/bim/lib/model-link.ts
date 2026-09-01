/**
 * Addressable model views.
 *
 * A wall is a thing two people need to look at together. Until the viewer's
 * state lives in the URL it cannot be pointed at: "the third wall on the left
 * in the ground floor" is what a colleague gets instead of a link, and an
 * answer that names an element can only describe it.
 *
 * So every view the model page can be in — which model, which storey, which
 * element, which highlights — is a query string. That one decision is what
 * makes the rest possible: an agent answer links to the element it is about, a
 * card opens the model already focused, a health finding jumps to the offending
 * walls, and a link pasted into a chat opens the same view for the person who
 * receives it.
 *
 * Pure string ↔ object, so both ends of that contract are tested rather than
 * assumed.
 */

import type { BimHighlightStatus } from './model-index'
import {
  defaultCameraState,
  encodeCameraState,
  parseCameraState,
  type BimViewerCameraState,
} from './viewer-camera'

/**
 * Which half of the model page is open.
 *
 * Part of the link, not local state: "open the Raumbuch of Haus-A" is a thing a
 * card, an agent answer and a colleague all need to be able to say, and a link
 * that lands on the overview and expects the reader to find the right tab is a
 * link that lost the point.
 */
export const BIM_MODEL_TABS = [
  'overview',
  'compliance',
  'structure',
  'quantities',
  'revisions',
] as const
export type BimModelTab = (typeof BIM_MODEL_TABS)[number]

const TABS = new Set<string>(BIM_MODEL_TABS)

export interface BimModelView {
  /** Model file name (not its id) — stable across re-ingestion and readable. */
  model?: string
  /** Which panel group is open; `overview` is the default and is not encoded. */
  tab?: BimModelTab
  /** Storey to isolate. */
  storey?: string
  /** Element to select, by IFC GlobalId. */
  element?: string
  /**
   * Elements to colour: `status:label:globalId,globalId`.
   *
   * The LABEL travels because it is the answer's own words. Without it the
   * viewer had to invent one from the severity, so "Fluchtweg > 40 m (12)" and
   * "Türbreite < 80 cm (4)" both arrived as "Fehler" — two identical legend
   * rows, and the meaning the answer supplied gone. It is optional: a link
   * written before this, or by hand, still parses.
   *
   * `total` is what the group counted BEFORE the id cap, so a link can say it
   * is showing 60 of 420 rather than quietly showing 60.
   */
  highlights?: Array<{
    status: BimHighlightStatus
    label?: string
    globalIds: string[]
    total?: number
  }>
  /** Ghost everything that is not highlighted or selected. */
  xray?: boolean
  /**
   * Camera direction, projection and section cut.
   *
   * Part of the link for the same reason the element is: a plan cut at
   * +2,60 m looking north is a view a colleague needs to open, not one they
   * need to be talked into reproducing.
   */
  camera?: BimViewerCameraState
}

const STATUSES = new Set<BimHighlightStatus>(['pass', 'fail', 'warning', 'info'])

/** Cap on ids per link, so a URL cannot grow past what a browser will follow. */
const MAX_LINK_IDS = 60

/**
 * `?model=haus-a.ifc&storey=Erdgeschoss&element=1kTv…&hl=fail:1kTv…,0RSw…&xray=1`
 *
 * Highlights are encoded as one `hl` parameter per status group rather than as
 * JSON: the URL stays readable in a chat message, and a truncated paste
 * degrades to fewer highlights instead of to a parse error.
 */
export function buildModelQuery(view: BimModelView): string {
  const params = new URLSearchParams()
  if (view.model) params.set('model', view.model)
  // `overview` is the default, so it stays out of the URL — a bare link should
  // look bare.
  // `overview` is encoded like any other tab. It used to be dropped as "the
  // default", which made it impossible to say "the drawer is open on the
  // overview" in a link — and since the drawer's open state is exactly
  // "`tab` is set", selecting Überblick silently closed the drawer for
  // whoever the link was sent to.
  if (view.tab) params.set('tab', view.tab)
  if (view.storey) params.set('storey', view.storey)
  if (view.element) params.set('element', view.element)
  for (const group of view.highlights ?? []) {
    const ids = group.globalIds.slice(0, MAX_LINK_IDS)
    if (ids.length === 0) continue
    // `status:label:ids`. The label is percent-encoded so a colon, a comma or
    // a space in the answer's own wording cannot be read as a separator —
    // `encodeURIComponent` also escapes `+`, which is what keeps the count
    // suffix below unambiguous.
    const label = encodeURIComponent(group.label ?? '')
    const total = group.total ?? group.globalIds.length
    // The count is appended only when it exceeds what fits, so an ordinary
    // link stays as short as it was.
    const suffix = total > ids.length ? `+${total}` : ''
    const middle = `${label}${suffix}`
    // A group with neither a label nor a cap emits the older, shorter
    // `status:ids` — the form a hand-written link takes, and the one most
    // links in the wild already are. Emitting `status::ids` for it would add a
    // character to every link to carry nothing.
    params.append(
      'hl',
      middle ? `${group.status}:${middle}:${ids.join(',')}` : `${group.status}:${ids.join(',')}`
    )
  }
  if (view.xray) params.set('xray', '1')
  if (view.camera) encodeCameraState(view.camera, params)
  const query = params.toString()
  return query ? `?${query}` : ''
}

/**
 * The route a model view opens on.
 *
 * Dateien, not a page of its own. A model is a file: it is uploaded here, it
 * is listed here, and `?model=` is what turns this page into the viewer for
 * one of them. The dedicated `/model` route is gone — it redirects here,
 * keeping its query string, so every link already written into a chat answer,
 * a card or a colleague's message still lands on the same view.
 */
export const MODEL_VIEW_SEGMENT = 'files'

/**
 * The Archiv's counterpart route.
 *
 * The org-wide Archiv is not under a project, so it cannot use the path above —
 * and it needs the same view state in the same query string, because the whole
 * point is that an `.ifc` behaves identically wherever it is opened. Same
 * `buildModelQuery`, so a view copied from one surface parses on the other.
 */
export const ARCHIV_MODEL_PATH = '/app/archiv'

/** Absolute in-app href for a model view. */
export function buildModelHref(projectId: string, view: BimModelView = {}): string {
  return `/app/projects/${projectId}/${MODEL_VIEW_SEGMENT}${buildModelQuery(view)}`
}

/** The same view, opened from the Archiv, where there is no project to name. */
export function buildArchivModelHref(view: BimModelView = {}): string {
  return `${ARCHIV_MODEL_PATH}${buildModelQuery(view)}`
}

/**
 * Read a view back out of a query string.
 *
 * Every field is optional and every malformed field is DROPPED rather than
 * failing the parse: a link that lost half its highlights in a paste should
 * still open the model at the right storey.
 */
export function parseModelView(search: string | URLSearchParams): BimModelView {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const view: BimModelView = {}

  const model = params.get('model')?.trim()
  if (model) view.model = model
  const tab = params.get('tab')?.trim()
  if (tab && TABS.has(tab)) view.tab = tab as BimModelTab
  const storey = params.get('storey')?.trim()
  if (storey) view.storey = storey
  const element = params.get('element')?.trim()
  if (element) view.element = element
  if (params.get('xray') === '1') view.xray = true

  // Always present, because "no camera in the link" is itself a camera — the
  // free view in perspective with no cut. A caller that had to distinguish
  // absent from default would get it wrong on the first link without one.
  const camera = parseCameraState(params)
  const fallback = defaultCameraState()
  const isDefault =
    camera.view === fallback.view &&
    camera.section === null &&
    camera.orthographic === fallback.orthographic
  if (!isDefault) view.camera = camera

  const highlights: NonNullable<BimModelView['highlights']> = []
  for (const raw of params.getAll('hl')) {
    const separator = raw.indexOf(':')
    if (separator <= 0) continue
    const status = raw.slice(0, separator) as BimHighlightStatus
    if (!STATUSES.has(status)) continue

    // Two shapes: `status:ids` (what links written before the label looked
    // like, and what a hand-written one still looks like) and
    // `status:label[+total]:ids`. The second colon is what tells them apart —
    // a GlobalId cannot contain one, so this cannot misread the older form.
    const rest = raw.slice(separator + 1)
    const second = rest.indexOf(':')
    const middle = second >= 0 ? rest.slice(0, second) : ''
    const idPart = second >= 0 ? rest.slice(second + 1) : rest

    const plus = middle.lastIndexOf('+')
    const totalText = plus >= 0 ? middle.slice(plus + 1) : ''
    const total = /^\d+$/.test(totalText) ? Number(totalText) : undefined
    const encodedLabel = plus >= 0 && total !== undefined ? middle.slice(0, plus) : middle
    let label: string | undefined
    try {
      label = decodeURIComponent(encodedLabel) || undefined
    } catch {
      // A truncated paste can leave a dangling escape. Losing the label is a
      // far smaller failure than losing the whole highlight.
      label = undefined
    }

    const globalIds = idPart
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, MAX_LINK_IDS)
    if (globalIds.length === 0) continue
    highlights.push({ status, ...(label ? { label } : {}), globalIds, ...(total ? { total } : {}) })
  }
  if (highlights.length > 0) view.highlights = highlights

  return view
}

/**
 * Merge a partial change into a view, dropping keys set to `undefined`.
 *
 * Used by every interaction on the page: selecting a storey must not wipe the
 * highlights an agent link arrived with, and clearing the element must remove
 * the parameter rather than leave `element=`.
 */
export function withModelView(current: BimModelView, patch: Partial<BimModelView>): BimModelView {
  const next: BimModelView = { ...current }
  for (const [key, value] of Object.entries(patch) as Array<
    [keyof BimModelView, BimModelView[keyof BimModelView]]
  >) {
    if (value === undefined || value === null || value === '' || value === false) delete next[key]
    else Object.assign(next, { [key]: value })
  }
  return next
}
