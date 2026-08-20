/**
 * @vitest-environment node
 */
/**
 * What the endpoint makes of a body.
 *
 * The contract this file guards is a compatibility one: `{ markdown }` shipped
 * first and is still all `useDownloadPdfRoute` sends, so the plain path is
 * asserted first and in the most detail. Everything else is additive, and the
 * rule for all of it is the one `answer-document.ts` states — a fact the caller
 * did not send produces no section, and never a placeholder. A date invented
 * for a document that never carried one is the failure mode worth a spec of its
 * own, because it is the one nobody catches by reading the PDF.
 */

import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { describe, expect, it } from 'vitest'
import type { DocBlock } from '@/lib/answer-export/blocks'
import { ReportPDF } from './ReactPdfDocument'
import { documentSections, hasContent, pdfRequestSchema } from './report-document'

/** Every heading in a body, as `level: text`. */
const headings = (blocks: DocBlock[]): string[] =>
  blocks
    .filter((block): block is Extract<DocBlock, { kind: 'heading' }> => block.kind === 'heading')
    .map((block) => `${block.level}: ${block.text}`)

/** All the text in a body, flattened — for "did this survive at all" checks. */
const allText = (blocks: DocBlock[]): string =>
  blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
          return block.text
        case 'paragraph':
          return block.runs.map((run) => run.text).join('')
        case 'bullets':
          return block.items.map((item) => item.map((run) => run.text).join('')).join(' ')
        case 'table':
          return [
            ...(block.head ?? []),
            ...block.rows.flatMap((row) => row.map((cell) => cell.map((run) => run.text).join(''))),
          ].join(' ')
        case 'rule':
          return ''
      }
    })
    .join('\n')

const parse = (body: unknown) => {
  const result = pdfRequestSchema.safeParse(body)
  if (!result.success) throw new Error(`payload rejected: ${result.error.message}`)
  return result.data
}

describe('the markdown-only contract', () => {
  const REPORT = [
    '# Fluchtwege in Gebäudeklasse 4',
    '',
    'Der Fluchtweg darf **40 m** nicht überschreiten [1].',
    '',
    '---',
    '',
    '## Beurteilung',
    '',
    '- Erster Punkt',
    '- Zweiter Punkt',
    '',
    '## Quellen',
    '',
    '1. [OIB-RL 2](https://www.oib.or.at/rl2.pdf), S. 18',
  ].join('\n')

  const { sections } = documentSections(parse({ markdown: REPORT }))

  it('takes the report’s own leading heading as the document title', () => {
    expect(sections.title).toBe('Fluchtwege in Gebäudeklasse 4')
  })

  it('does not print that title again as the first line of the body', () => {
    expect(headings(sections.body)).not.toContain('1: Fluchtwege in Gebäudeklasse 4')
    expect(headings(sections.body)).not.toContain('2: Fluchtwege in Gebäudeklasse 4')
  })

  it('does not wrap the report in an "Answer" heading', () => {
    // A report IS the document; a section heading announcing the whole file
    // states a structure the report does not have.
    expect(headings(sections.body)).not.toContain('2: Answer')
  })

  it('states no date, because the caller stated none', () => {
    expect(sections.facts).toEqual([])
  })

  it('turns the written sources section into a real reference list', () => {
    expect(headings(sections.body)).toContain('2: Sources')
    // The entry survives with its address, so the `[1]` left in the prose still
    // points at something.
    expect(allText(sections.body)).toContain('https://www.oib.or.at/rl2.pdf')
    // …and the raw "## Quellen" prose is gone, rather than being stated twice.
    expect(headings(sections.body)).not.toContain('3: Quellen')
  })

  it('keeps the author’s own thematic break', () => {
    expect(sections.body.some((block) => block.kind === 'rule')).toBe(true)
  })

  it('falls back to the dictionary title when the report has no heading', () => {
    const plain = documentSections(parse({ markdown: 'Nur Fließtext, keine Überschrift.' }))
    expect(plain.sections.title).toBe('Answer')
  })

  it('answers in the language the reader read the answer in', () => {
    const german = documentSections(parse({ markdown: REPORT, locale: 'de' }))
    expect(headings(german.sections.body)).toContain('2: Quellen')
    expect(german.locale).toBe('de')
  })
})

describe('the richer contract', () => {
  const request = parse({
    markdown: '## Beurteilung\n\nDer Fluchtweg ist zulässig.',
    title: 'Seestadt Bauteil C',
    projectName: 'Wohnhaus Seestadt',
    question: 'Wie lang darf der Fluchtweg sein?',
    createdAt: '2026-08-19T09:30:00.000Z',
    cards: [
      {
        type: 'stair_diagram',
        title: 'Haupttreppe',
        riser_height: { label: 'Steigung', value: 18.2, required: 18, unit: 'cm', status: 'warning' },
      },
    ],
    citations: {
      v: 1,
      sources: [{ title: 'OIB-Richtlinie 2', number: 1, page: 18, url: 'https://www.oib.or.at/rl2.pdf' }],
    },
    confidence: { level: 'medium', reason: 'Die Fluchtweglänge ist belegt, die Türbreite nicht.' },
  })

  const { sections } = documentSections(request)

  it('puts the title and the header facts on the cover, not in the body', () => {
    expect(sections.title).toBe('Seestadt Bauteil C')
    expect(sections.facts.map((fact) => fact.label)).toEqual(['Project', 'Created on'])
    expect(sections.facts[0].value).toBe('Wohnhaus Seestadt')
    expect(sections.facts[1].value).toBe('August 19, 2026')
    expect(headings(sections.body)).not.toContain('1: Seestadt Bauteil C')
  })

  it('carries the question, the findings and the sources as their own sections', () => {
    expect(headings(sections.body)).toEqual(
      expect.arrayContaining(['2: Question', '2: Answer', '2: Findings', '2: Sources'])
    )
  })

  it('renders the cards through the shape-walker, not through a card renderer here', () => {
    // The card's title and its check both reached the body without this module
    // knowing what a `stair_diagram` is.
    expect(allText(sections.body)).toContain('Haupttreppe')
    expect(allText(sections.body)).toContain('18.2')
  })

  it('states no date when the caller sent none, and none when it sent nonsense', () => {
    for (const createdAt of [undefined, '', 'gestern']) {
      const { sections: withoutDate } = documentSections(
        parse({ markdown: 'Text', title: 'Titel', createdAt })
      )
      expect(withoutDate.facts.map((fact) => fact.label)).not.toContain('Created on')
    }
  })

  it('exports an answer that is nothing but a card', () => {
    const cardsOnly = parse({ cards: [{ type: 'summary', title: 'Kurzfassung', content: 'Zulässig.' }] })
    expect(hasContent(cardsOnly)).toBe(true)
    expect(allText(documentSections(cardsOnly).sections.body)).toContain('Kurzfassung')
  })
})

describe('what the endpoint refuses', () => {
  it('has nothing to print for an empty body, or for prose that is only whitespace', () => {
    expect(hasContent(parse({}))).toBe(false)
    expect(hasContent(parse({ markdown: '   \n  ' }))).toBe(false)
    expect(hasContent(parse({ cards: [] }))).toBe(false)
  })

  it('accepts fields it does not know rather than failing the export', () => {
    // A client one deploy ahead must still get its PDF.
    expect(pdfRequestSchema.safeParse({ markdown: '# Titel', somethingNew: 42 }).success).toBe(true)
  })
})

describe('end to end', () => {
  it('renders a PDF for the original markdown-only body', async () => {
    const buffer = await renderToBuffer(
      <ReportPDF request={parse({ markdown: '# Bericht\n\nEin Absatz.' })} />
    )

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('renders a PDF for a body carrying cards and citations', async () => {
    const buffer = await renderToBuffer(
      <ReportPDF
        request={parse({
          markdown: 'Der Fluchtweg ist zulässig [1].',
          title: 'Seestadt',
          createdAt: '2026-08-19T09:30:00.000Z',
          cards: [{ type: 'summary', title: 'Kurzfassung', key_points: ['Zulässig', 'Türbreite offen'] }],
          citations: { v: 1, sources: [{ title: 'OIB-RL 2', number: 1, page: 18 }] },
          locale: 'de',
        })}
      />
    )

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
