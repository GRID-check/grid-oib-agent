'use client'

/**
 * Open a document's Prüfansicht at one mark, over the conversation, without
 * leaving it.
 *
 * ## The one way in
 *
 * The file preview pane already answers a link into the review: `review=1`
 * and `mark=<annotationId>` (and `tool`) open the full-screen review at that
 * mark once the pane shows the document as a PDF. The pane keeps them in the
 * URL while the review is open, `mark` and `tool` following the selection and
 * the tool in hand, and takes them off when it closes (`file-preview-pane.tsx`),
 * so a reload stays in the review and Back leaves it. So this adds no second
 * channel into the canvas. It puts the document in the pane the chat already
 * has beside it (the preview store, the way a citation opens one) and writes
 * those params onto the CURRENT url with `router.replace`: the session, the
 * scroll and the composer stay as they were.
 *
 * Closing the review is the review's own Escape or ✕, or Back. The params go,
 * the document stays in the peek beside the chat, and the conversation is
 * where it was.
 *
 * ## No `doc` on the chat
 *
 * On the project chat `?doc=` is the subject of an Ask Piloti link (a new chat
 * about that file, `project-chat-client.tsx`), so the chat's review link never
 * carries it: the pane in the peek takes `review` and `mark` for the document
 * it shows, which is the one this helper just put there.
 *
 * ## Off the chat
 *
 * A surface with no pane beside it (the card gallery, a report) goes to the
 * project's Dateien with `doc`, `review` and `mark`, whose modal pane answers
 * them the same way.
 */

import { useFilePreviewStore } from '../stores/file-preview-store'
import { openFiledDocument } from './open-filed-document'
import { documentFilesHref } from './document-question'

export const REVIEW_PARAM = 'review'
export const MARK_PARAM = 'mark'
export const DOC_PARAM = 'doc'
/** The tool in hand when the review opens: „Anmerken" arms the point. */
export const TOOL_PARAM = 'tool'

/** The tools a link may arm: the ones that set a mark. Selecting is the review's own start. */
export type ReviewLinkTool = 'point' | 'region'
const isReviewLinkTool = (value: string | null | undefined): value is ReviewLinkTool =>
  value === 'point' || value === 'region'

export interface ReviewTarget {
  documentId: string
  /** The mark to open the review at; absent opens the review at its start. */
  annotationId?: string | null
  /** A tool to have in hand when the review opens. */
  tool?: ReviewLinkTool | null
}

/** What a page's params say about the review: open, at which mark, with which tool. */
export interface ReviewParams {
  /** The document `doc` names, where the page names one. */
  documentId: string | null
  open: boolean
  annotationId: string | null
  tool: ReviewLinkTool | null
}

/** Read the review off a page's params. A `mark` or `tool` without `review` opens nothing. */
export function readReviewParams(params: Pick<URLSearchParams, 'get'> | null | undefined): ReviewParams {
  const open = Boolean(params?.get(REVIEW_PARAM))
  const tool = params?.get(TOOL_PARAM)
  return {
    documentId: params?.get(DOC_PARAM) || null,
    open,
    annotationId: open ? params?.get(MARK_PARAM) || null : null,
    tool: open && isReviewLinkTool(tool) ? tool : null,
  }
}

/** Take the review off `params` (mutates it). `doc` stays: the document is still open. */
export function clearReviewParams(params: URLSearchParams): URLSearchParams {
  params.delete(REVIEW_PARAM)
  params.delete(MARK_PARAM)
  params.delete(TOOL_PARAM)
  return params
}

/** `pathname` with `params`, without a dangling `?`. */
export const hrefWithParams = (pathname: string, params: URLSearchParams): string => {
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

/** Where a review link points: `pathname`, `search` and `hash` of a URL. */
export type ReviewLocation = Pick<Location, 'pathname' | 'search' | 'hash'>

/** Set the review's params on `params` (mutates it); `doc` only where the page needs to be told which file. */
export function setReviewParams(
  params: URLSearchParams,
  target: ReviewTarget,
  { withDocument }: { withDocument: boolean }
): URLSearchParams {
  if (withDocument) params.set(DOC_PARAM, target.documentId)
  params.set(REVIEW_PARAM, '1')
  if (target.annotationId) params.set(MARK_PARAM, target.annotationId)
  else params.delete(MARK_PARAM)
  if (target.tool) params.set(TOOL_PARAM, target.tool)
  else params.delete(TOOL_PARAM)
  return params
}

/**
 * The page's own URL with the review link on it: `review` and `mark`, and
 * every other param and the hash kept, so what is on screen stays on screen.
 * The chat's link carries no `doc` (see the module comment); a shelf's
 * listing (Dateien, the Archiv) names the document with `withDocument`, and
 * its `?doc=` sync opens it with the review.
 */
export function reviewHrefAt(
  location: ReviewLocation,
  target: ReviewTarget,
  { withDocument = false }: { withDocument?: boolean } = {}
): string {
  const params = setReviewParams(new URLSearchParams(location.search), target, { withDocument })
  return `${location.pathname}?${params.toString()}${location.hash}`
}

/** The review link into a project's Dateien, for a surface with no pane of its own. */
export function reviewFilesHref(projectId: string, target: ReviewTarget): string {
  const base = documentFilesHref(projectId, target.documentId)
  const [path, search = ''] = base.split('?')
  return `${path}?${setReviewParams(new URLSearchParams(search), target, { withDocument: true }).toString()}`
}

/** Whether a pathname is a project's chat, which keeps the file pane beside the conversation. */
export const isProjectChatPath = (pathname: string): boolean => /^\/app\/projects\/[^/]+\/chat\/?$/.test(pathname)

export interface DocumentBesideOptions {
  projectId: string
  projectName?: string | null
  canCollaborate?: boolean
}

/**
 * Put a document in the pane beside the chat, unless it is there already.
 * `false` when the document could not be read (gone, or not the reader's).
 *
 * The composer's subject is left alone: looking at a mark is not asking about
 * the document, and the conversation that holds the card already has its own.
 */
export async function showDocumentBeside(documentId: string, options: DocumentBesideOptions): Promise<boolean> {
  const preview = useFilePreviewStore.getState()
  if (preview.file?.id === documentId) {
    if (preview.hidden || preview.mode === 'modal') preview.peek()
    return true
  }
  return openFiledDocument({
    documentId,
    projectId: options.projectId,
    projectName: options.projectName,
    canCollaborate: options.canCollaborate,
  })
}

export interface OpenReviewOptions extends DocumentBesideOptions {
  /** `router.replace` on the chat (the link only addresses the pane), `router.push` to Dateien. */
  navigate: (href: string, how: 'replace' | 'push') => void
  /** The page the reader is on; defaults to `window.location`. */
  location?: ReviewLocation
}

/** How the review was opened: beside the chat, on the Dateien page, or not at all. */
export type OpenReviewResult = 'beside' | 'files' | 'unavailable'

/** Open the document's Prüfansicht at the mark, over whatever the reader is in. */
export async function openReviewAt(target: ReviewTarget, options: OpenReviewOptions): Promise<OpenReviewResult> {
  const location = options.location ?? window.location
  if (!isProjectChatPath(location.pathname)) {
    options.navigate(reviewFilesHref(options.projectId, target), 'push')
    return 'files'
  }
  if (!(await showDocumentBeside(target.documentId, options))) return 'unavailable'
  options.navigate(reviewHrefAt(location, target), 'replace')
  return 'beside'
}
