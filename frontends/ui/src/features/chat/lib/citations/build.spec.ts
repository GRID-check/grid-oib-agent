/**
 * The model's contract, driven by the failures it exists to remove.
 *
 * Each test names a real defect: a document cited at several pages rendering as
 * one good chip and N degraded ones, the trace and the answer disagreeing about
 * what was read, a card and a citation naming the same Richtlinie twice.
 */

import { describe, expect, it, test } from 'vitest'
import type { GridCard } from '@/shared/cards/schemas'
import type { ReportSourceEntry } from '@/features/layout/lib/report-citations'
import type { TraceLaneCard } from '../trace-lanes'
import type { CitationSource } from '../../types'
import { buildCitationModel } from './build'
import {
  answerDocuments,
  answerSourceAnchorPrefix,
  bibliographyRows,
  splitAnswerBody,
  unusedDocuments,
} from './views'
import { citationNumbers, citedPages, isCited } from './model'

const OIB_FILE = 'oib-rl_2.1_ausgabe_mai_2023.pdf'
const OIB_TITLE = 'OIB-Richtlinie 2.1, Ausgabe Mai 2023'

/** One structured wire source — i.e. ONE LOCUS of a document. */
const wireLocus = (number: number, page: number): CitationSource => ({
  id: `c${number}`,
  content: `[KB] ${OIB_FILE}, p.${page}`,
  timestamp: new Date(0),
  origin: 'kb',
  kind: 'baurecht',
  lane: 'baurecht_oib',
  laneLabel: 'OIB-Richtlinie',
  title: OIB_TITLE,
  citationKey: `${OIB_FILE}, p.${page}`,
  collection: 'oib_knowledge',
  fileName: OIB_FILE,
  page,
  number,
  isCited: true,
})

/** The same locus as the answer's written `## Quellen` list spells it. */
const writtenEntry = (number: number, page: number): ReportSourceEntry => ({
  number,
  markdown: `${OIB_FILE}, p.${page}`,
  sourceKind: 'kb',
})

describe('buildCitationModel', () => {
  it('folds one document cited at four pages into ONE document with four loci', () => {
    // The reported defect: this produced one complete chip and three degraded
    // ones (raw filename, no authority badge, wrong tint) because the
    // document-level dedup starved the locus-level 1:1 match.
    const docs = buildCitationModel({
      citations: [wireLocus(1, 5), wireLocus(2, 12), wireLocus(3, 18), wireLocus(4, 22)],
      entries: [writtenEntry(1, 5), writtenEntry(2, 12), writtenEntry(3, 18), writtenEntry(4, 22)],
    })

    expect(docs).toHaveLength(1)
    const doc = docs[0]!
    expect(doc.title).toBe(OIB_TITLE)
    expect(doc.authority).toBe('OIB')
    expect(doc.tint).toBe('oib')
    expect(doc.kind).toBe('baurecht')
    expect(citedPages(doc)).toEqual([5, 12, 18, 22])
    expect(citationNumbers(doc)).toEqual([1, 2, 3, 4])
  })

  it('keeps every [N] addressable — one bibliography row per inline marker', () => {
    const docs = buildCitationModel({
      citations: [wireLocus(1, 5), wireLocus(2, 12)],
      entries: [writtenEntry(1, 5), writtenEntry(2, 12)],
    })
    // The document-level view is one row; the locus-level view is two, so an
    // inline [2] in the prose still leads somewhere.
    expect(answerDocuments(docs)).toHaveLength(1)
    expect(bibliographyRows(docs).map((row) => row.number)).toEqual([1, 2])
  })

  it('gives a written entry with no structured match the same identity as one with', () => {
    // A written entry alone used to render as its raw filename with no tint and
    // no badge. It must resolve exactly like the structured path does.
    const docs = buildCitationModel({ entries: [writtenEntry(1, 7)] })
    expect(docs).toHaveLength(1)
    expect(docs[0]!.title).toBe(OIB_TITLE)
    expect(docs[0]!.fileName).toBe(OIB_FILE)
    expect(citedPages(docs[0]!)).toEqual([7])
  })

  it('never merges same-named documents from different shelves', () => {
    const projectPlan: CitationSource = {
      id: 'p',
      content: 'Plan.pdf, p.1',
      timestamp: new Date(0),
      kind: 'projekt',
      collection: 'proj_abc',
      fileName: 'Plan.pdf',
      page: 1,
      isCited: true,
    }
    const archivPlan: CitationSource = {
      ...projectPlan,
      id: 'a',
      kind: 'buero',
      collection: 'archiv_xyz',
    }
    const docs = buildCitationModel({ citations: [projectPlan, archivPlan] })
    expect(docs).toHaveLength(2)
    expect(docs.map((doc) => doc.kind).sort()).toEqual(['buero', 'projekt'])
  })

  it('collapses a legal_basis card onto the citation naming the same Richtlinie', () => {
    const card = {
      type: 'legal_basis',
      law: 'OIB-Richtlinie 2.1',
      section: '2.1.1',
      original_text: 'Garagen sind so auszuführen …',
    } as unknown as GridCard

    const docs = buildCitationModel({ citations: [wireLocus(1, 5)], cards: [card] })
    expect(docs).toHaveLength(1)
    // The card must not overwrite the structured document's own title.
    expect(docs[0]!.title).toBe(OIB_TITLE)
    expect(docs[0]!.fileName).toBe(OIB_FILE)
  })

  it('separates what was read from what was used', () => {
    const lanes: TraceLaneCard[] = [
      {
        key: 'baurecht_oib',
        label: 'OIB-Richtlinie',
        kind: 'baurecht',
        signal: 'law',
        hitCount: 2,
        sources: [
          { name: OIB_FILE, title: OIB_TITLE, detail: 'p.5' },
          { name: 'oib-rl_4_ausgabe_mai_2023.pdf', title: 'OIB-Richtlinie 4', detail: 'p.9' },
        ],
      },
    ]
    // Only the first document was cited; the second was retrieved and dropped.
    const docs = buildCitationModel({ citations: [wireLocus(1, 5)], traceLanes: lanes })

    expect(docs).toHaveLength(2)
    expect(answerDocuments(docs).map((doc) => doc.fileName)).toEqual([OIB_FILE])
    expect(unusedDocuments(docs).map((doc) => doc.fileName)).toEqual([
      'oib-rl_4_ausgabe_mai_2023.pdf',
    ])
    // The trace's own hit on p.5 is the SAME locus the citation used — folded,
    // not duplicated, and raised to cited.
    const cited = answerDocuments(docs)[0]!
    expect(cited.loci).toHaveLength(1)
    expect(isCited(cited)).toBe(true)
  })

  it('keeps a web source linking out and tinted as web', () => {
    const web: CitationSource = {
      id: 'w',
      content: 'https://www.wko.at/artikel',
      url: 'https://www.wko.at/artikel',
      timestamp: new Date(0),
      kind: 'web',
      lane: 'web',
      origin: 'web',
      number: 1,
      isCited: true,
    }
    const docs = buildCitationModel({ citations: [web] })
    expect(docs).toHaveLength(1)
    expect(docs[0]!.title).toBe('wko.at')
    expect(docs[0]!.tint).toBe('auto')
    expect(docs[0]!.url).toBe('https://www.wko.at/artikel')
  })

  it('is order-independent — a late citation_use only raises a locus', () => {
    const discovered: CitationSource = { ...wireLocus(0, 5), number: undefined, isCited: false }
    const used: CitationSource = { ...wireLocus(3, 5), title: undefined, laneLabel: undefined }

    const forward = buildCitationModel({ citations: [discovered, used] })[0]!
    const reverse = buildCitationModel({ citations: [used, discovered] })[0]!

    for (const doc of [forward, reverse]) {
      expect(doc.loci).toHaveLength(1)
      expect(doc.loci[0]!.isCited).toBe(true)
      expect(doc.loci[0]!.number).toBe(3)
      expect(doc.title).toBe(OIB_TITLE)
    }
  })
})

describe('splitAnswerBody', () => {
  test('lifts the written sources section out and linkifies the inline markers', () => {
    const answer = [
      'Garagen brauchen zwei Fluchtwege [1] und 2,50 m Stellplatzbreite [2].',
      '',
      '## Quellen',
      '- [1] [RIS] Wiener Garagengesetz 2008 — https://www.ris.bka.gv.at/x',
      '- [2] [KB] oib-rl_4_ausgabe_mai_2023.pdf, p.9',
    ].join('\n')

    const { body, entries } = splitAnswerBody(answer, 'answer-source-m1-')

    expect(entries).toHaveLength(2)
    expect(body).not.toContain('## Quellen')
    expect(body).not.toContain('oib-rl_4_ausgabe_mai_2023.pdf')
    expect(body).toContain('[\\[1\\]](#answer-source-m1-1)')
    expect(body).toContain('[\\[2\\]](#answer-source-m1-2)')
  })

  test('leaves an answer without a sources section untouched', () => {
    const answer = 'Kurze Antwort ohne Quellenteil.'
    expect(splitAnswerBody(answer, 'p-')).toEqual({ body: answer, entries: [] })
  })

  test('anchor prefixes are per message so two answers never collide', () => {
    expect(answerSourceAnchorPrefix('m1')).not.toBe(answerSourceAnchorPrefix('m2'))
  })
})

describe('provenance selection', () => {
  const web = (i: number): CitationSource => ({
    id: `c${i}`,
    url: `https://host-${i}.example.com/a`,
    content: '',
    timestamp: new Date(0),
    isCited: true,
  })

  it('returns nothing when the turn carries no provenance at all', () => {
    expect(buildCitationModel({})).toEqual([])
  })

  it('prefers the sources the answer actually cited', () => {
    const cited = { ...web(1), isCited: true }
    const discovered = { ...web(2), isCited: false }
    const docs = buildCitationModel({ citations: [cited, discovered] })

    expect(docs).toHaveLength(2)
    expect(answerDocuments(docs).map((doc) => doc.url)).toEqual([cited.url])
  })

  it('falls back to every source when none carries the cited flag', () => {
    // Messages persisted before the flag existed. Showing everything retrieved
    // is a weaker claim than "these are the sources", but an honest one —
    // showing nothing would hide grounding that exists.
    const docs = buildCitationModel({
      citations: [
        { ...web(1), isCited: undefined },
        { ...web(2), isCited: undefined },
      ],
    })
    expect(answerDocuments(docs)).toHaveLength(2)
  })

  it('deduplicates by URL', () => {
    const docs = buildCitationModel({
      citations: [web(1), { ...web(1), id: 'other' }],
    })
    expect(docs).toHaveLength(1)
  })

  it('keeps a legal_basis card that names a DIFFERENT document than the citation', () => {
    const card = { type: 'legal_basis', law: 'OIB-Richtlinie 4' } as unknown as GridCard
    const docs = buildCitationModel({ citations: [wireLocus(1, 5)], cards: [card] })
    expect(docs).toHaveLength(2)
  })
})

describe('a source known only from the written list', () => {
  it('still renders as the OIB document it is', () => {
    // The written `## Quellen` line carries no lane and no kind — only a
    // filename. It used to produce a law-tinted chip with no authority badge,
    // sitting beside an identical structured citation in a different colour.
    const [doc] = buildCitationModel({ entries: [writtenEntry(1, 9)] })

    expect(doc!.lane).toBe('baurecht_oib')
    expect(doc!.kind).toBe('baurecht')
    expect(doc!.tint).toBe('oib')
    expect(doc!.authority).toBe('OIB')
  })

  it('renders identically to the same document with a full structured wire', () => {
    const fromEntry = buildCitationModel({ entries: [writtenEntry(1, 5)] })[0]!
    const fromWire = buildCitationModel({ citations: [wireLocus(1, 5)] })[0]!

    expect([fromEntry.title, fromEntry.tint, fromEntry.authority, fromEntry.kind]).toEqual([
      fromWire.title,
      fromWire.tint,
      fromWire.authority,
      fromWire.kind,
    ])
  })
})
