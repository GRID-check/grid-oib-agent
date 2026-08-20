/**
 * Markdown to the bytes of a PDF, on the server.
 *
 * ## Why this module exists at all
 *
 * `ReactPdfDocument.tsx` describes a document; it does not produce a file. The
 * one place in the repo that turned that description into bytes was the
 * `POST /api/generate-pdf` handler, inline — so the second caller (a
 * commissioned research report, filed into a project) would have had to copy
 * the stream-to-Buffer loop, and the two would have diverged on the thing that
 * is easy to get subtly wrong: whether the stream is fully drained before the
 * Buffer is handed on. A truncated PDF still starts with `%PDF-`.
 *
 * So the idiom lives here once, and both callers are callers.
 *
 * `renderToStream` and not `renderToBuffer`, even though 4.6.0 has both:
 * `package.json` declares `@react-pdf/renderer: ^4.3.2`, and a fresh install
 * that resolves lower must still build. `renderToStream` is the API this repo
 * has already shipped against.
 */

import 'server-only'
import React from 'react'
import { renderToStream } from '@react-pdf/renderer'
import { aiProvenanceKeywords, AI_GENERATOR_NAME, type AiProvenance } from '@/lib/ai-provenance'
import {
  MarkdownPDF,
  type PdfHeader,
  type PdfMetadata,
  type PdfNotice,
  type PdfSection,
} from './ReactPdfDocument'

/** The MIME type a browser needs to show the bytes inline. */
export const PDF_MEDIA_TYPE = 'application/pdf'

/**
 * The largest markdown this module will render, in characters.
 *
 * ## Why the bound is on the INPUT and not on the time
 *
 * A wall-clock timeout is the bound this obviously wants, and it does not
 * exist. `renderToStream`'s layout pass is one long SYNCHRONOUS block:
 * measured here, a 3-second `setTimeout` armed before a 128 KiB table-heavy
 * render fired at **32.5 seconds**, and an interval ticking every 250 ms
 * managed one tick in the first 3.5 seconds and then nothing until the render
 * was done. So a timeout does not merely fail to help — it reports a deadline
 * it did not enforce, at a moment of the renderer's choosing, and the work it
 * "cancelled" runs to completion anyway (the abandoned render above finished
 * 2.5 s later). There is nothing to race and nothing to abort.
 *
 * That same measurement is the real severity of an unbounded render, and it is
 * worse than "a slow request": Node is single-threaded, so for those 32 seconds
 * this process served NOBODY. Every other request queued behind one PDF.
 *
 * What is left is admission — refuse before starting, because after starting
 * there is no observation point and no exit. Hence a character cap, which is a
 * proxy, and the paragraph below is about how good a proxy it is.
 *
 * ## What 64 KiB costs, measured
 *
 * Node 22, this repository, `renderMarkdownPdf`, one render per fresh process,
 * peak RSS sampled at 25 ms (the process floor with react-pdf loaded is
 * ~145 MB):
 *
 *   | markdown | prose        | mixed report  | dense tables   |
 *   |----------|--------------|---------------|----------------|
 *   | 32 KiB   | 0.6 s/170 MB | 1.3 s/174 MB  | 4.0 s/234 MB   |
 *   | 64 KiB   | 1.0 s/189 MB | 2.4 s/205 MB  | 11.0 s/387 MB  |
 *   | 128 KiB  | 1.4 s/220 MB | 4.9 s/283 MB  | 37.2 s/723 MB  |
 *   | 192 KiB  | 2.5 s/252 MB | 8.4 s/386 MB  | 77.4 s/897 MB  |
 *   | 256 KiB  | 3.0 s/296 MB | 12.9 s/456 MB | 141.7 s/1190 MB|
 *
 * **Bytes are a bad proxy and the spread is the reason the cap is not larger.**
 * At every size the same byte count costs ~10x more as tables than as prose,
 * because a table cell is a flex `<View>` the layout engine measures and
 * re-measures, and a paragraph is one text run. The cap cannot see shape, so it
 * has to be sized for the worst shape, not the average — 64 KiB is the last
 * size at which the WORST shape stays in single-digit-to-eleven seconds and
 * under 400 MB, and prose at that size costs a second.
 *
 * Memory is the sharper edge, and it is the one this number is really set by:
 * 1.2 GB of peak RSS for one document is not a slow response, it is an OOM that
 * takes the container and every request in it. Time degrades; memory kills.
 *
 * An earlier note on `POST /api/generate-pdf` recorded 61 s for 128 KiB "of
 * headings and paragraphs". That could not be reproduced — prose of that size
 * renders in 1.4 s here. The number was right about the danger and wrong about
 * the cause: what costs 61 seconds is not 128 KiB, it is 128 KiB of TABLES. The
 * conclusion (64 KiB) survives; the reasoning behind it did not, which is why
 * the table above names three shapes instead of one.
 *
 * ## Characters, not bytes
 *
 * Layout cost tracks glyphs, so a character count is better correlated with the
 * work than a UTF-8 byte count — „Fußbodenaufbau" costs its umlaut nothing to
 * lay out and one extra byte to store. It is also the unit
 * `POST /api/generate-pdf` already refuses on, and one document must not have
 * two ceilings.
 *
 * ## Refusal, not truncation
 *
 * The same argument `MAX_DIAGRAM_SVG_DEPTH` makes about a tree, for the same
 * reason: a PDF that stops mid-section is a file that opens, looks finished and
 * is not. These documents are handed to Behörden. A report missing its last
 * three findings, with nothing on the page saying so, is worse than a report
 * that was never filed — the second failure is visible to somebody.
 */
export const MAX_MARKDOWN_PDF_CHARS = 64 * 1024

/**
 * The refusal, as a named error rather than a generic one.
 *
 * Named for the reason `DiagramSvgError` is: a caller has to be able to tell
 * "this input is too big" — which is a fact about the document, stable across
 * retries, and worth telling a person — apart from "the renderer fell over",
 * which is worth retrying. A bare `Error` collapses the two into "something
 * went wrong", and this path's failures are already swallowed by a caller that
 * logs and moves on (`fileReportIfCommissioned`), so the message in the log is
 * the whole of what an operator gets.
 */
export class MarkdownTooLongError extends Error {
  constructor(
    readonly length: number,
    readonly limit: number = MAX_MARKDOWN_PDF_CHARS,
  ) {
    super(`markdown is ${length} characters; the renderer accepts at most ${limit}`)
    this.name = 'MarkdownTooLongError'
  }
}

export interface MarkdownPdfOptions {
  /** The document's own title, for the Info dictionary and the window chrome. */
  title?: string
  /**
   * A statement about the document, printed on page one. The caller supplies
   * the words — see {@link PdfNotice}.
   */
  notice?: PdfNotice
  /**
   * The block that identifies the document and its subject, printed under the
   * notice — never above it. Absent by default: an export of prose a person
   * read on screen has no project to name and no run to point at, and a header
   * with one row saying today's date is chrome.
   */
  header?: PdfHeader
  /**
   * Matter appended after the markdown, each under its own heading. Absent by
   * default; an empty array renders nothing, so a caller with no cards to show
   * never prints a heading standing over nothing.
   */
  sections?: PdfSection[]
  /**
   * Present when the content was generated and not reviewed by a human.
   *
   * Absent — the default — writes no marking at all, which is what keeps the
   * marking meaningful: `POST /api/generate-pdf` exports a report a person read
   * on screen and chose to download, and stamping that one too would make the
   * stamp mean nothing. The same argument `DocxOptions.aiProvenance` makes.
   */
  aiProvenance?: AiProvenance
}

/**
 * The Info-dictionary fields for one rendering.
 *
 * `subject` carries the notice's HEADLINE rather than a description of the
 * report, and that is a compromise worth naming: react-pdf exposes no custom
 * property (see `@/lib/ai-provenance`), so the marking has to live in fields
 * that were meant for something else. `Subject` is the field a person actually
 * sees in a viewer's document-properties panel, so putting „KI-generiert —
 * nicht geprüft" there means the marking survives even for a reader who never
 * scrolls to page one — and it is only ever set when there IS a notice, so an
 * ordinary export's Subject is not overwritten with something it did not say.
 */
function metadataFor(options: MarkdownPdfOptions): PdfMetadata | undefined {
  const { title, notice, aiProvenance } = options
  if (!title && !notice && !aiProvenance) return undefined
  return {
    title,
    subject: notice?.title,
    ...(aiProvenance
      ? { keywords: aiProvenanceKeywords(aiProvenance), creator: AI_GENERATOR_NAME }
      : {}),
  }
}

/**
 * What `renderToStream` will accept.
 *
 * Named off the function's own signature rather than written out, because the
 * type it wants — `ReactElement<DocumentProps>` — is declared inside
 * `@react-pdf/renderer`'s `declare namespace` WITHOUT `export`, so
 * `DocumentProps` cannot be imported and no honest annotation can name it.
 */
type PdfDocumentElement = Parameters<typeof renderToStream>[0]

/**
 * Render markdown into the bytes of a PDF.
 *
 * The chunks are collected to completion before the Buffer is built — a partial
 * PDF is a file that opens and is missing its last pages, which is worse than
 * one that fails to open, because nobody notices.
 */
export async function renderMarkdownPdf(
  markdown: string,
  options: MarkdownPdfOptions = {}
): Promise<Uint8Array> {
  // BEFORE anything is parsed or laid out, because there is no second chance:
  // the layout pass blocks the event loop, so this is the last instruction that
  // runs on schedule. See {@link MAX_MARKDOWN_PDF_CHARS}.
  //
  // Here and not in each caller. `POST /api/generate-pdf` bounds its own input
  // and `research-report.ts` did not, which is the shape of every invariant
  // this repository has had to move inwards — the no-ingest rule went from
  // `fileGeneratedDocument` to `dispatchDocument` for exactly this reason, and
  // ADR-0042 says it about admission: an invariant enforced at each caller is
  // an invariant each caller can forget. The route's own `.max()` is not
  // redundant with this, it is EARLIER and better-shaped for a request (a 400
  // naming the field, before a render is attempted); this is the floor under
  // every caller that has no request to shape an answer for.
  if (markdown.length > MAX_MARKDOWN_PDF_CHARS) {
    throw new MarkdownTooLongError(markdown.length)
  }

  const element = React.createElement(MarkdownPDF, {
    markdown,
    notice: options.notice,
    header: options.header,
    sections: options.sections,
    metadata: metadataFor(options),
  })

  // THE one cast in this module, and the boundary it sits on: react-pdf types
  // its renderers as taking an element whose props ARE `DocumentProps`, but
  // every real caller passes a component that RETURNS a `<Document>` — the
  // library's own README does the same. The two prop types share no member, so
  // TS rejects a direct assertion and `unknown` is the only route. It is safe
  // for exactly one reason, checked here rather than assumed: `MarkdownPDF`
  // renders `<Document>` as its root (see `ReactPdfDocument.tsx`), which is
  // what the renderer requires — and it is what the specs render for real
  // rather than trusting.
  const stream = await renderToStream(element as unknown as PdfDocumentElement)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return new Uint8Array(Buffer.concat(chunks))
}
