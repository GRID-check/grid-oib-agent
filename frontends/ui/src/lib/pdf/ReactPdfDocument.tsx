/**
 * The exported document, as a react-pdf element.
 *
 * The rendering is {@link BlocksDocument}, which consumes the same `DocBlock[]`
 * the Word exporter consumes. "What a heading looks like" is therefore decided
 * once, in the block vocabulary, and the PDF can show a card because the
 * shape-walker in `lib/answer-export/cards.ts` is shared rather than ported. This
 * file is the adapter from a request to a document. The markdown reader is
 * `lib/answer-export/markdown.ts`, which lexes the same markdown with the same
 * library for the other format.
 *
 * `MarkdownPDF` keeps its name and its props because it is the published entry
 * point of this module — the endpoint's `{ markdown }` contract still resolves
 * through it, and arrives branded.
 */

import React from 'react'
import { BlocksDocument } from './blocks-to-pdf'
import type { DocumentChrome } from './branding'
import { documentSections, type PdfRequest } from './report-document'

interface ReportPDFProps {
  /** The parsed request body. Every field but the prose is optional. */
  request: PdfRequest
  /**
   * The branding this document carries, resolved by
   * `lib/documents/branding.ts`.
   *
   * A PROP and deliberately not a field on {@link PdfRequest}. The request is
   * what `POST /api/generate-pdf` parses off a browser, and branding is prose
   * printed on a cover sheet in the product's own voice — a field on the
   * request would let any signed-in caller put a sentence of their own choosing
   * where the document says who is answerable for it. Only the server-side
   * filing paths, which resolve it from the platform default and the
   * organization's override, can pass this.
   */
  branding?: DocumentChrome
}

/**
 * A branded document built from the full request: cover, running chrome, the
 * report body, the answer's cards and its reference list.
 */
export const ReportPDF: React.FC<ReportPDFProps> = ({ request, branding }) => {
  const { sections } = documentSections(request)
  return (
    <BlocksDocument
      // The marking goes on the COVER, above the facts — the first thing on the
      // first page, before the document says whose project it is. A reader who
      // stops after the cover has still been told what they are holding.
      cover={{
        title: sections.title,
        facts: sections.facts,
        notice: sections.notice ?? undefined,
        chrome: branding,
      }}
      blocks={sections.body}
      keywords={request.aiProvenance}
      subject={sections.notice?.title}
    />
  )
}

interface MarkdownPDFProps {
  markdown: string
}

/** The markdown-only document — the endpoint's `{ markdown }` contract. */
export const MarkdownPDF: React.FC<MarkdownPDFProps> = ({ markdown }) => (
  <ReportPDF request={{ markdown }} />
)
