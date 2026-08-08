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

const MODEL_PATH = /^\/app\/projects\/([^/?#]+)\/model(?:\?([^#]*))?$/

/**
 * Recognise `/app/projects/:id/model?element=…` in an answer's markdown.
 *
 * Returns `null` for anything else — an absolute URL to another host, a link to
 * the files page, a fragment — so the caller falls through to its normal link
 * rendering. Absolute same-origin URLs are accepted too, because an agent that
 * composes a link from a base URL produces those.
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
  return { projectId, view: parseModelView(match[2] ?? '') }
}

/**
 * The href a chip links to — rebuilt from the parsed view rather than reused
 * verbatim, so a link carrying junk parameters opens a clean view.
 */
export function elementLinkHref(link: BimElementLink): string {
  return buildModelHref(link.projectId, link.view)
}
