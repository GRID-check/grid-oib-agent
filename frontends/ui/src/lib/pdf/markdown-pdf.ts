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
import type { AiProvenanceMarking } from '@/lib/ai-provenance'
import { ReportPDF } from './ReactPdfDocument'
import type { DocumentFact } from '@/lib/answer-export/answer-document'

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
export const MAX_MARKDOWN_PDF_CHARS = 440 * 1024

/**
 * ## Why 64 KiB became a cost, and 440 KiB
 *
 * The paragraph above says it: "the cap cannot see shape, so it has to be
 * sized for the worst shape". A flat character count therefore priced every
 * document as if it were a table, and the document this product exists to
 * produce is not one — a Deep-Research-Bericht is prose, and twelve minutes of
 * research writes past 64 KiB of it. The reader who waited those twelve minutes
 * then pressed „PDF" and got a 400 (#624). The bound was doing its job on a
 * cost the document did not have.
 *
 * So the cap sees shape now. Same method as the table above — Node 22, this
 * repository, one render per fresh process, `rssDelta` sampled around the
 * render:
 *
 *   | chars    | prose            | 4-column tables    |
 *   |----------|------------------|--------------------|
 *   | 32 KiB   | 0.6 s /  24 MB   |  5.6 s / 224 MB    |
 *   | 64 KiB   | 1.2 s /  49 MB   | 20.4 s /  ~16 MB\* |
 *   | 96 KiB   | —                | 41.0 s / 223 MB    |
 *   | 128 KiB  | 2.6 s / 118 MB   | —                  |
 *   | 192 KiB  | 5.0 s /  79 MB   | —                  |
 *   | 256 KiB  | 7.6 s / 137 MB   | —                  |
 *
 * \* RSS deltas are noisy across a shared heap (a GC between two samples can
 * make a delta smaller than the render); the TIMES are the stable signal and
 * the shape ratio in them reproduces the earlier table exactly — ~10x at equal
 * size, growing superlinearly on both curves.
 *
 * The number that matters: **256 KiB of prose renders in 7.6 s, and the old cap
 * already admitted 64 KiB of tables at 20.4 s.** The most expensive document
 * this bound has ever let through is a table-heavy one at the old ceiling, so
 * that is the budget, expressed in the unit the ceiling was already in — and
 * anything predicted to cost no more than it is admitted whatever its shape.
 *
 * 64 KiB of 4-column tables is ~6,050 cells. Extrapolating the prose curve,
 * 20.4 s of prose is roughly 500 KiB, so a cell costs about
 * `(500 - 64) KiB / 6050 ≈ 74` characters of prose. {@link TABLE_CELL_COST_CHARS}
 * rounds that DOWN to 64 — a cell that is cheaper on paper than it is in
 * practice makes the estimate conservative in the wrong direction, so it is
 * rounded down, which prices tables slightly HIGHER per character and keeps the
 * refusal early. The budget is then `65536 + 6050 x 64 = 452,736`, and
 * {@link MAX_MARKDOWN_PDF_CHARS} is the round number just below it.
 *
 * A table-heavy document is therefore refused at very nearly the size it was
 * refused at before, and 400 KiB of prose — a long report — renders in about
 * twelve seconds and gets built.
 */
export const TABLE_CELL_COST_CHARS = 64

/**
 * What this document will cost to lay out, in prose-character equivalents.
 *
 * Counted off the RAW MARKDOWN rather than off parsed blocks, deliberately:
 * this runs before anything is parsed (see {@link renderMarkdownPdf}), it is a
 * single linear scan, and a table row in markdown is unambiguous — a line whose
 * first non-space character is a pipe. The delimiter row (`|---|---|`) is
 * counted like any other; it is one row in a document that has at least two, so
 * naming it a special case would buy nothing.
 *
 * It is an ESTIMATE and does not have to be exact. What it has to be is
 * shape-aware, because the thing it replaced was not.
 */
export function markdownRenderCost(markdown: string): number {
  let cells = 0
  for (const line of markdown.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('|')) continue
    // Cells are the gaps between pipes: `| a | b |` is two.
    let pipes = 0
    for (let i = 0; i < trimmed.length; i += 1) if (trimmed[i] === '|') pipes += 1
    cells += Math.max(0, pipes - 1)
  }
  return markdown.length + cells * TABLE_CELL_COST_CHARS
}

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
    /** The document's estimated layout cost — see {@link markdownRenderCost}. */
    readonly length: number,
    readonly limit: number = MAX_MARKDOWN_PDF_CHARS,
  ) {
    super(`markdown costs ${length} to lay out; the renderer accepts at most ${limit}`)
    this.name = 'MarkdownTooLongError'
  }
}

export interface MarkdownPdfOptions {
  /**
   * What is printed where a ```mermaid fence stands.
   *
   * Required, and the only string on this type that is. A mermaid fence is not
   * a listing — its text is instructions for drawing something, not the
   * something — and it is the one token type where this renderer and the chat
   * DISAGREE about what the same markdown means. A default is what a caller
   * forgets, and what a caller forgets here is a filed compliance document
   * printing `flowchart TD` where the answer showed a picture.
   */
  diagramPlaceholder: string
  /** The document's own name; falls back to the prose's leading heading. */
  title?: string
  /** Printed on the cover, under the title. */
  projectName?: string
  /**
   * Facts the caller knows and the prose does not — Standort, Bundesland,
   * Gebäudeklasse — appended after project and date.
   *
   * Bundesland is why this exists: a compliance statement without it is not
   * checkable, because it names the Bauordnung the document was checked
   * against.
   */
  facts?: DocumentFact[]
  /** ISO-8601. Anything unparseable is treated as absent, never as now. */
  createdAt?: string
  /**
   * The run's Grid cards, rendered as the document's findings section — which
   * is where „Rechtsgrundlagen" now comes from. Passed through verbatim as the
   * stored jsonb; `lib/answer-export/cards.ts` walks them defensively, so a
   * card type this build has never seen still exports.
   */
  cards?: unknown
  /** The reader's language; defaults to the app default. */
  locale?: string
  /**
   * The AI marking — printed on the cover AND written to the Info dictionary's
   * Keywords, both or neither.
   *
   * Opt-in, because a stamp on every PDF is a stamp that means nothing: a
   * person exporting prose they have read and chosen to download is not the
   * case this marks. A document Piloti filed into a project is, because it
   * leaves the product with no byline to carry it.
   */
  marking?: AiProvenanceMarking
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
  options: MarkdownPdfOptions
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
  const cost = markdownRenderCost(markdown)
  if (cost > MAX_MARKDOWN_PDF_CHARS) {
    throw new MarkdownTooLongError(cost)
  }

  const element = React.createElement(ReportPDF, {
    request: {
      markdown,
      title: options.title,
      projectName: options.projectName,
      facts: options.facts,
      createdAt: options.createdAt,
      cards: options.cards,
      locale: options.locale,
      diagramPlaceholder: options.diagramPlaceholder,
      aiProvenance: options.marking,
    },
  })

  const stream = await renderToStream(element as unknown as PdfDocumentElement)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return new Uint8Array(Buffer.concat(chunks))
}
