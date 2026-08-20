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
import { MarkdownPDF, type PdfMetadata, type PdfNotice } from './ReactPdfDocument'

/** The MIME type a browser needs to show the bytes inline. */
export const PDF_MEDIA_TYPE = 'application/pdf'

export interface MarkdownPdfOptions {
  /** The document's own title, for the Info dictionary and the window chrome. */
  title?: string
  /**
   * A statement about the document, printed on page one. The caller supplies
   * the words — see {@link PdfNotice}.
   */
  notice?: PdfNotice
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
  const element = React.createElement(MarkdownPDF, {
    markdown,
    notice: options.notice,
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
