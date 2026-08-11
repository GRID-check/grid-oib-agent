/**
 * From an element to a conversation, and back.
 *
 * The model page and the chat are the same investigation seen twice. Someone
 * clicks a wall, sees that it carries no fire rating, and the next thing they
 * want is not another panel — it is to ask. Without this, asking means
 * describing the wall in prose to an assistant that cannot see the selection,
 * which is exactly the "talking about a file" the model was supposed to end.
 *
 * Two directions, both plain strings so both are testable:
 *
 * - **Out** — `elementQuestionHref` turns the current selection into the
 *   project chat's existing `?ask=` prefill, carrying the element's GlobalId so
 *   the agent's `ifc_query` lands on the same element the person is looking at.
 * - **Back** — `parseElementLink` recognises a model deep link inside an answer
 *   so it can render as a chip that opens the viewer on that element, rather
 *   than as a raw URL a reader has to trust and click blind.
 *
 * The GlobalId is in the question text on purpose. It is the one identifier
 * that survives a re-export, it is what the tool filters on, and a question that
 * carried only "the wall I selected" would be unanswerable in a new session.
 */

import { buildModelHref, parseModelView, type BimModelView } from './model-link'

export interface BimElementRef {
  globalId: string
  ifcType: string
  name: string | null
  storeyName?: string | null
}

/** `IfcWallStandardCase` → `Wall`, matching how the tables label a type. */
function readableType(ifcType: string): string {
  return ifcType.replace(/^Ifc/, '').replace(/StandardCase$/, '')
}

/** How an element is named in a sentence: its name, else its type and id. */
export function describeElement(element: BimElementRef): string {
  const type = readableType(element.ifcType)
  const named = element.name?.trim()
  const base = named ? `${type} „${named}“` : type
  return element.storeyName ? `${base} (${element.storeyName})` : base
}

/**
 * The question the "Ask Piloti" button sends to the composer.
 *
 * Phrased as an open question rather than a command: the point is to start a
 * conversation about this element, not to run one canned report. The identifiers
 * ride along so the agent can resolve it without a follow-up.
 */
export function buildElementQuestion(
  element: BimElementRef,
  options: { modelFilename?: string | null } = {}
): string {
  const parts = [`Was gilt für ${describeElement(element)} im Modell?`]
  const context = [`GlobalId ${element.globalId}`]
  if (options.modelFilename) context.push(`Modell ${options.modelFilename}`)
  parts.push(`(${context.join(', ')})`)
  return parts.join(' ')
}

/** `/app/projects/:id/chat?ask=…` — the composer prefill the chat page consumes. */
export function elementQuestionHref(
  projectId: string,
  element: BimElementRef,
  options: { modelFilename?: string | null } = {}
): string {
  const params = new URLSearchParams({ ask: buildElementQuestion(element, options) })
  return `/app/projects/${projectId}/chat?${params.toString()}`
}

/** A model deep link found in an answer, resolved to what it points at. */
export interface BimElementLink {
  projectId: string
  view: BimModelView
}

/**
 * Both routes, on purpose.
 *
 * `files` is where a model view lives now. `model` is where it lived when
 * every answer in every existing conversation was written, and those links are
 * in the database — an agent answer from last month naming a wall has to keep
 * opening that wall. The old route redirects, so a chip built from a legacy
 * link lands in the same place; recognising it HERE is what lets it render as
 * a chip at all rather than as a bare URL the reader has to trust.
 *
 * A model link is one that carries model-view parameters. `/files` on its own
 * is the file browser and must keep rendering as an ordinary link, or every
 * mention of the Dateien page in an answer turns into an element chip.
 */
const MODEL_PATH = /^\/app\/projects\/([^/?#]+)\/(files|model)(?:\?([^#]*))?$/

/** Parameters that make a `/files` link a MODEL link rather than a page link. */
const VIEW_PARAMS = ['model', 'element', 'storey', 'hl', 'xray', 'tab', 'view', 'cut']

/**
 * Recognise `/app/projects/:id/files?element=…` in an answer's markdown.
 *
 * Returns `null` for anything else — an absolute URL to another host, a link
 * to a different page, a fragment — so the caller falls through to its normal
 * link rendering. Absolute same-origin URLs are accepted too, because an agent
 * that composes a link from a base URL produces those.
 */
export function parseElementLink(href: string | undefined): BimElementLink | null {
  if (!href) return null
  let path = href
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href)
      path = `${url.pathname}${url.search}`
    } catch {
      return null
    }
  }
  const match = MODEL_PATH.exec(path)
  if (!match) return null
  const projectId = decodeURIComponent(match[1])
  if (!projectId) return null

  const search = match[3] ?? ''
  // The legacy route was ONLY ever the model, so a bare `/model` link still
  // means "open the model". `/files` has to say so.
  if (match[2] === 'files') {
    const params = new URLSearchParams(search)
    if (!VIEW_PARAMS.some((name) => params.has(name))) return null
  }
  return { projectId, view: parseModelView(search) }
}

/**
 * The href a chip links to — rebuilt from the parsed view rather than reused
 * verbatim, so a link carrying junk parameters opens a clean view.
 */
export function elementLinkHref(link: BimElementLink): string {
  return buildModelHref(link.projectId, link.view)
}
