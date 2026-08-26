/**
 * The exported document, as a react-pdf element.
 *
 * ## What used to be here
 *
 * This file was a second markdown renderer: it lexed the report with `marked`
 * and mapped the tokens straight onto react-pdf primitives, with its own inline
 * emphasis parser, its own table code and its own copy of the design tokens.
 * That made it a fourth place — after the app, the Word exporter and the block
 * vocabulary — where "what a heading looks like" was decided, and it is why the
 * PDF was the one export that could not show a card: teaching it to would have
 * meant porting the shape-walker in `lib/answer-export/cards.ts` into a file
 * that had no idea cards existed.
 *
 * So the rendering moved to {@link BlocksDocument}, which consumes the same
 * `DocBlock[]` the Word exporter consumes, and this file became what it should
 * always have been: the two-line adapter from a request to a document. The
 * markdown reader it used to own is `lib/answer-export/markdown.ts`, which was
 * already lexing the same markdown with the same library for the other format.
 *
 * `MarkdownPDF` keeps its name and its props because it is the published entry
 * point of this module — the endpoint's original `{ markdown }` contract still
 * resolves through it, and now arrives branded.
 */

import React from 'react'
import { BlocksDocument } from './blocks-to-pdf'
import { documentSections, type PdfRequest } from './report-document'

interface ReportPDFProps {
  /** The parsed request body. Every field but the prose is optional. */
  request: PdfRequest
}

/**
 * A branded document built from the full request: cover, running chrome, the
 * report body, the answer's cards and its reference list.
 */
export const ReportPDF: React.FC<ReportPDFProps> = ({ request }) => {
  const { sections } = documentSections(request)
  return (
    <BlocksDocument
      // The marking goes on the COVER, above the facts — the first thing on the
      // first page, before the document says whose project it is. A reader who
      // stops after the cover has still been told what they are holding.
      cover={{ title: sections.title, facts: sections.facts, notice: sections.notice ?? undefined }}
      blocks={sections.body}
      keywords={request.aiProvenance}
      subject={sections.notice?.title}
    />
  )
}

interface MarkdownPDFProps {
  markdown: string
}

/** The markdown-only document — the endpoint's original contract. */
export const MarkdownPDF: React.FC<MarkdownPDFProps> = ({ markdown }) => (
  <ReportPDF request={{ markdown }} />
)
