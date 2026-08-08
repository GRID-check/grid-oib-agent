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

/**
 * Which half of the model page is open.
 *
 * Part of the link, not local state: "open the Raumbuch of Haus-A" is a thing a
 * card, an agent answer and a colleague all need to be able to say, and a link
 * that lands on the overview and expects the reader to find the right tab is a
 * link that lost the point.
 */
export const BIM_MODEL_TABS = ['overview', 'structure', 'quantities', 'revisions'] as const
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
  /** Elements to colour, `status:globalId,globalId`. */
  highlights?: Array<{ status: BimHighlightStatus; globalIds: string[] }>
  /** Ghost everything that is not highlighted or selected. */
  xray?: boolean
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
  if (view.tab && view.tab !== 'overview') params.set('tab', view.tab)
  if (view.storey) params.set('storey', view.storey)
  if (view.element) params.set('element', view.element)
  for (const group of view.highlights ?? []) {
    const ids = group.globalIds.slice(0, MAX_LINK_IDS)
    if (ids.length === 0) continue
    params.append('hl', `${group.status}:${ids.join(',')}`)
  }
  if (view.xray) params.set('xray', '1')
  const query = params.toString()
  return query ? `?${query}` : ''
}

/** Absolute in-app href for a model view. */
export function buildModelHref(projectId: string, view: BimModelView = {}): string {
  return `/app/projects/${projectId}/model${buildModelQuery(view)}`
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
  if (tab && TABS.has(tab) && tab !== 'overview') view.tab = tab as BimModelTab
  const storey = params.get('storey')?.trim()
  if (storey) view.storey = storey
  const element = params.get('element')?.trim()
  if (element) view.element = element
  if (params.get('xray') === '1') view.xray = true

  const highlights: NonNullable<BimModelView['highlights']> = []
  for (const raw of params.getAll('hl')) {
    const separator = raw.indexOf(':')
    if (separator <= 0) continue
    const status = raw.slice(0, separator) as BimHighlightStatus
    if (!STATUSES.has(status)) continue
    const globalIds = raw
      .slice(separator + 1)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, MAX_LINK_IDS)
    if (globalIds.length === 0) continue
    highlights.push({ status, globalIds })
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
