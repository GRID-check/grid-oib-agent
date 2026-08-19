/**
 * What lands on the clipboard.
 *
 * The point of copying the SOURCE markdown rather than the rendered block is
 * that the parts which make an answer usable as evidence survive the paste, so
 * that is what these check: the `[N]` numbering, the tables, the emphasis, and
 * a sources list that still names a document, a page and a link once it is
 * outside Piloti. Plus the one thing that must NOT survive: `[[card:N]]`.
 */

import { describe, expect, it } from 'vitest'
import { buildCitationModel, type CitedDocument } from './citations'
import type { CitationSource } from '../types'
import {
  answerMarkdown,
  answerMarkdownWithSources,
  hasCopyableSources,
  sourcesMarkdown,
  stripCardMarkers,
} from './answer-markdown'

const labels = {
  heading: 'Quellen',
  page: (page: number) => `S. ${page}`,
  pages: (pages: number[]) => `S. ${pages.join(', ')}`,
  untitled: 'Quelle ohne Titel',
}

const source = (overrides: Partial<CitationSource> & { id: string }): CitationSource => ({
  content: '',
  timestamp: new Date('2026-08-18T09:00:00Z'),
  ...overrides,
})

const oib: CitationSource = source({
  id: 'c1',
  title: 'OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023',
  fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
  citationKey: 'oib-rl_2_ausgabe_mai_2023.pdf, p.18',
  collection: 'oib_knowledge',
  kind: 'baurecht',
  origin: 'kb',
  page: 18,
  number: 1,
  isCited: true,
})

const ris: CitationSource = source({
  id: 'c2',
  title: 'Wiener Bauordnung § 87',
  url: 'https://www.ris.bka.gv.at/wiener-bauordnung',
  kind: 'baurecht',
  origin: 'ris',
  number: 2,
  isCited: true,
})

describe('stripCardMarkers', () => {
  it('takes a marker line out without leaving a hole behind it', () => {
    const out = stripCardMarkers('Erster Absatz.\n\n[[card:1]]\n\nZweiter Absatz.')
    expect(out).toBe('Erster Absatz.\n\nZweiter Absatz.')
  })

  it('cuts a mid-sentence marker out of the sentence', () => {
    expect(stripCardMarkers('Die Höhe [[card:2]] ist maßgeblich.')).toBe(
      'Die Höhe  ist maßgeblich.'
    )
  })

  it('leaves an answer without markers byte-identical apart from trimming', () => {
    const md = '## Ergebnis\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n**Fett** und [1].'
    expect(stripCardMarkers(md)).toBe(md)
  })
})

describe('answerMarkdown', () => {
  it('keeps the citation numbering, the table and the emphasis', () => {
    const content =
      'Die Fluchtweglänge ist auf **40 m** begrenzt [1].\n\n' +
      '| Gebäudeklasse | Länge |\n| --- | --- |\n| GK 4 | 40 m |\n\n' +
      '## Quellen\n\n1. OIB-Richtlinie 2, S. 18'
    expect(answerMarkdown(content)).toBe(content)
  })

  it('carries the answer’s own written sources section along', () => {
    expect(answerMarkdown('Antwort.\n\n[[card:1]]\n\n## Quellen\n\n1. OIB-RL 2')).toBe(
      'Antwort.\n\n## Quellen\n\n1. OIB-RL 2'
    )
  })
})

describe('sourcesMarkdown', () => {
  it('writes out one numbered line per [N], with page and link', () => {
    const documents = buildCitationModel({ citations: [oib, ris] })
    const out = sourcesMarkdown(documents, labels)

    expect(out).toContain('## Quellen')
    expect(out).toContain('[1] OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023, S. 18')
    expect(out).toContain('oib-rl_2_ausgabe_mai_2023.pdf')
    expect(out).toContain('[2] Wiener Bauordnung § 87 — https://www.ris.bka.gv.at/wiener-bauordnung')
  })

  it('numbers by the marker the prose wrote, not by list position', () => {
    const documents = buildCitationModel({
      citations: [source({ ...ris, number: 7 }), source({ ...oib, number: 3 })],
    })
    const lines = sourcesMarkdown(documents, labels).split('\n').filter((l) => l.startsWith('['))

    expect(lines[0]).toMatch(/^\[3\] OIB-Richtlinie 2/)
    expect(lines[1]).toMatch(/^\[7\] Wiener Bauordnung/)
  })

  it('lists a source the answer leaned on without numbering as a bullet', () => {
    const documents = buildCitationModel({
      cards: [
        {
          type: 'legal_basis',
          law: 'Wiener Bauordnung',
          article: '§ 87',
          original_text: 'Der Fluchtweg …',
        },
      ] as never,
    })

    expect(hasCopyableSources(documents)).toBe(true)
    expect(sourcesMarkdown(documents, labels)).toContain('- Wiener Bauordnung')
  })

  it('is empty — and reports itself empty — for an answer with no sources', () => {
    const documents: CitedDocument[] = []
    expect(hasCopyableSources(documents)).toBe(false)
    expect(sourcesMarkdown(documents, labels)).toBe('')
  })
})

describe('answerMarkdownWithSources', () => {
  it('appends the resolved list under the label the answer uses', () => {
    const documents = buildCitationModel({ citations: [oib] })
    const out = answerMarkdownWithSources('Die Antwort [1].', documents, labels)

    expect(out).toBe(
      'Die Antwort [1].\n\n## Quellen\n\n' +
        '[1] OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023, S. 18 — oib-rl_2_ausgabe_mai_2023.pdf'
    )
  })

  it('returns the prose untouched when the turn resolved no sources', () => {
    expect(answerMarkdownWithSources('Nur Prosa.', [], labels)).toBe('Nur Prosa.')
  })
})
