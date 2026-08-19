import type { NextApiRequest, NextApiResponse } from 'next'
import React from 'react'
import { renderToStream } from '@react-pdf/renderer'
import { ReportPDF } from '../../lib/pdf/ReactPdfDocument'
import { hasContent, pdfRequestSchema } from '../../lib/pdf/report-document'

/**
 * POST /api/generate-pdf
 *
 * Receives the report or answer to print, as JSON. The original contract was
 * `{ markdown: string }` and still is: every other field is optional, and a
 * body carrying only markdown produces the same document it always did — now
 * with the Piloti cover, running header and page footer around it.
 *
 * The richer body lets a caller hand over what the markdown cannot carry:
 *
 *   { markdown, title?, projectName?, question?, createdAt?,
 *     cards?, citations?, confidence?, locale? }
 *
 * `cards` and `citations` are the stored `metadata.*` payloads, verbatim. They
 * are read by the shape-walkers in `lib/answer-export`, which treat them as
 * untrusted jsonb — so a card type this build has never seen still exports.
 *
 * Returns: `application/pdf`, as an attachment.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const parsed = pdfRequestSchema.safeParse(req.body)

    // The 400 keeps the wording it shipped with. A client that was told
    // "Invalid or missing markdown content" and now gets a schema dump would
    // have to be changed to keep showing the user a sentence they can act on.
    if (!parsed.success || !hasContent(parsed.data)) {
      return res.status(400).json({ error: 'Invalid or missing markdown content' })
    }

    const stream = await renderToStream(
      React.createElement(ReportPDF, { request: parsed.data }) as React.ReactElement
    )

    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }

    const pdfBuffer = Buffer.concat(chunks)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"')
    res.send(pdfBuffer)
  } catch (error) {
    console.error('[PDF] Error generating PDF:', error)
    res.status(500).json({
      error: 'Failed to generate PDF',
      details: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}
