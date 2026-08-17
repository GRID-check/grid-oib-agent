import { describe, test, expect, vi } from 'vitest'
import { toCslItem, toFachtext, toFachtextList, toQuoteList } from './source-citation'
import { renderCitations } from './citation-export'
import { renderCitations as renderOnServer } from '@/lib/citations/render'
import { buildCitationModel, type CitationRef } from './citations'
import type { CitationSource } from '../types'

const NOW = new Date('2026-07-28T12:00:00Z')

/**
 * Fixtures go through the REAL model rather than being hand-built, so a change
 * to how a document is identified, titled or tinted shows up here instead of
 * being papered over by a literal that no producer would ever emit.
 */
const refFor = (citation: CitationSource): CitationRef => {
  const [document] = buildCitationModel({ citations: [citation] })
  if (!document) throw new Error('fixture produced no document')
  return { document, locus: document.loci[0] }
}

const oib = refFor({
  id: 'c1',
  content: '',
  timestamp: NOW,
  title: 'OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023',
  fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
  citationKey: 'oib-rl_2_ausgabe_mai_2023.pdf, p.18',
  collection: 'oib_knowledge',
  kind: 'baurecht',
  lane: 'baurecht_oib',
  origin: 'kb',
  page: 18,
  number: 1,
  isCited: true,
})

const law = refFor({
  id: 'c2',
  content: '',
  timestamp: NOW,
  title: 'Bauordnung für Wien § 108',
  kind: 'baurecht',
  lane: 'baurecht_ris',
  laneLabel: 'Rechtsquelle (RIS)',
  origin: 'ris',
  url: 'https://www.ris.bka.gv.at/x',
  number: 2,
  isCited: true,
})

const projectDoc = refFor({
  id: 'c3',
  content: '',
  timestamp: NOW,
  title: 'Grundriss EG',
  fileName: 'Grundriss_EG.pdf',
  citationKey: 'Grundriss_EG.pdf, p.2',
  collection: 'proj_abc',
  kind: 'projekt',
  lane: 'projekt',
  origin: 'kb',
  page: 2,
  number: 3,
  isCited: true,
})

describe('toCslItem', () => {
  test('an OIB Richtlinie is a CSL standard with publisher, edition and page', () => {
    const csl = toCslItem(oib, NOW)

    expect(csl.type).toBe('standard')
    expect(csl.publisher).toBe('Österreichisches Institut für Bautechnik')
    expect(csl['publisher-place']).toBe('Wien')
    expect(csl.edition).toBe('Ausgabe Mai 2023')
    expect(csl.issued).toEqual({ 'date-parts': [[2023, 5]] })
    expect(csl.page).toBe('18')
  })

  test('a RIS source is CSL legislation carrying the retrieval container + access date', () => {
    const csl = toCslItem(law, NOW)

    expect(csl.type).toBe('legislation')
    expect(csl['container-title']).toBe('Rechtsinformationssystem des Bundes (RIS)')
    expect(csl.URL).toBe('https://www.ris.bka.gv.at/x')
    expect(csl.accessed).toEqual({ 'date-parts': [[2026, 7]] })
  })

  test('a project upload is a report, not a publication, and claims no publisher', () => {
    const csl = toCslItem(projectDoc, NOW)

    expect(csl.type).toBe('report')
    expect(csl.publisher).toBeUndefined()
    expect(csl.note).toBe('Grundriss_EG.pdf')
    expect(csl.page).toBe('2')
  })

  test('nothing is invented: no edition phrase → no edition and no issued date', () => {
    // Neither the title nor the filename states an edition, so the citation
    // must not carry one — a fabricated Fundstelle is worse than a short one.
    const csl = toCslItem(
      refFor({
        id: 'c4',
        content: '',
        timestamp: NOW,
        title: 'OIB-Richtlinie 2 – Brandschutz',
        kind: 'baurecht',
        lane: 'baurecht_oib',
        origin: 'kb',
        isCited: true,
      }),
      NOW
    )

    expect(csl.edition).toBeUndefined()
    expect(csl.issued).toBeUndefined()
  })
})

describe('toFachtext', () => {
  test('cites an OIB Richtlinie the way the OIB itself does', () => {
    expect(toFachtext(oib, NOW)).toBe(
      'OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023, S. 18 ' +
        '(Österreichisches Institut für Bautechnik, Wien).'
    )
  })

  test('cites a legal norm with its source and retrieval date', () => {
    expect(toFachtext(law, NOW)).toBe(
      'Bauordnung für Wien § 108, in: Rechtsinformationssystem des Bundes (RIS), ' +
        'abgerufen am 28.07.2026: https://www.ris.bka.gv.at/x.'
    )
  })

  test('numbers the bibliography the way the answer cites it', () => {
    expect(toFachtextList([oib, law], NOW).split('\n')[1]).toMatch(/^\[2\] Bauordnung/)
  })
})

describe('toQuoteList', () => {
  test('lists the cited sentences, not just the document name', () => {
    const quoted = refFor({
      id: 'c3',
      content: 'Die maximale Fluchtweglänge beträgt 40 m.',
      timestamp: NOW,
      title: 'OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023',
      fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
      citationKey: 'oib-rl_2_ausgabe_mai_2023.pdf, p.18',
      collection: 'oib_knowledge',
      kind: 'baurecht',
      lane: 'baurecht_oib',
      origin: 'kb',
      page: 18,
      number: 1,
      isCited: true,
    })
    const text = toQuoteList([quoted], NOW)
    expect(text).toContain('Die maximale Fluchtweglänge beträgt 40 m.')
    expect(text).toContain('OIB-Richtlinie 2')
    expect(text).toContain('S. 18')
  })

  test('falls back to Fachtext when no passage was retrieved', () => {
    expect(toQuoteList([oib], NOW)).toBe(toFachtextList([oib], NOW))
  })
})

// The bibliographic formats are rendered by citation-js on the BFF (it is a
// Node library and cannot run in the browser) — exercise the real renderer.
describe('server-side citation rendering', () => {
  test('BibTeX comes out importable, with a real entry per source', async () => {
    const bibtex = await renderOnServer([toCslItem(oib, NOW), toCslItem(law, NOW)], 'bibtex')

    expect(bibtex).toMatch(/@\w+\{/)
    expect(bibtex).toContain('Brandschutz')
    expect(bibtex).toContain('Bauordnung')
  })

  test('RIS (.ris) export carries the tagged records EndNote/Zotero read', async () => {
    const ris = await renderOnServer([toCslItem(law, NOW)], 'ris')

    expect(ris).toMatch(/^TY {2}- /m)
    expect(ris).toMatch(/^ER {2}- ?$/m)
  })

  test('APA renders a formatted bibliography', async () => {
    const apa = await renderOnServer([toCslItem(oib, NOW)], 'apa')

    expect(apa).toContain('OIB-Richtlinie 2')
    expect(apa.length).toBeGreaterThan(20)
  })
})

describe('renderCitations', () => {
  test('falls back to the Fachtext bibliography when the format route fails', async () => {
    const failing = vi.fn().mockResolvedValue({ ok: false })
    vi.stubGlobal('fetch', failing)

    const text = await renderCitations([oib], 'bibtex', NOW)

    expect(failing).toHaveBeenCalledOnce()
    expect(text).toContain('OIB-Richtlinie 2 – Brandschutz')
    vi.unstubAllGlobals()
  })

  test('posts the CSL-JSON to the BFF and returns what it rendered', async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: '@standard{…}' }) })
    vi.stubGlobal('fetch', ok)

    expect(await renderCitations([oib], 'bibtex', NOW)).toBe('@standard{…}')
    const body = JSON.parse((ok.mock.calls[0][1] as { body: string }).body)
    expect(body.format).toBe('bibtex')
    expect(body.items[0].type).toBe('standard')
    vi.unstubAllGlobals()
  })

  test('CSL-JSON is valid JSON with one item per source', async () => {
    const json = JSON.parse(await renderCitations([oib, law, projectDoc], 'csl-json', NOW))

    expect(json).toHaveLength(3)
    expect(json[0].type).toBe('standard')
  })

  test('no sources → empty string, never a stray header', async () => {
    expect(await renderCitations([], 'bibtex', NOW)).toBe('')
  })
})

describe('CSL ids are unique per reference', () => {
  test('two pages of one document export as two entries, not one', () => {
    // A bibliography lists one row per LOCUS and CSL consumers key on `id`, so
    // two unnumbered pages of the same document collided and the importer
    // silently dropped one.
    const page = (n: number): CitationSource => ({
      id: `c${n}`,
      content: `[KB] Plan.pdf, p.${n}`,
      citationKey: `Plan.pdf, p.${n}`,
      fileName: 'Plan.pdf',
      collection: 'proj_1',
      timestamp: NOW,
      kind: 'projekt',
      page: n,
      isCited: true,
    })
    const [document] = buildCitationModel({ citations: [page(3), page(9)] })
    const ids = document!.loci.map((locus) => toCslItem({ document: document!, locus }, NOW).id)

    expect(new Set(ids).size).toBe(2)
    // The id is written as the BibTeX key, and the parts it is built from are
    // storage identities: an unescaped comma from a locus key ("Plan.pdf, p.3")
    // ends the key mid-entry and the record stops parsing.
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  test('two loci that sanitize alike still export as two entries', () => {
    // Reducing an id to BibTeX-safe characters maps `,` and `;` onto the same
    // `-`, so two loci of one document whose keys differ only in punctuation
    // collided — and a CSL consumer keys on `id`, so one row overwrote the
    // other. Sanitizing must not undo the per-locus identity.
    const keyed = (citationKey: string, n: number): CitationSource => ({
      id: `c${n}`,
      content: `[KB] ${citationKey}`,
      citationKey,
      fileName: 'Plan.pdf',
      collection: 'archiv_1',
      timestamp: NOW,
      kind: 'buero',
      isCited: true,
    })
    const [document] = buildCitationModel({
      citations: [keyed('Plan.pdf, p.3', 1), keyed('Plan.pdf; p.3', 2)],
    })
    const ids = document!.loci.map((locus) => toCslItem({ document: document!, locus }, NOW).id)

    expect(document!.loci).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  test('a locus known only by its citation key still yields a usable key', () => {
    // No page, so the locus is keyed on the citation key itself — commas,
    // spaces and dots included.
    const [document] = buildCitationModel({
      citations: [
        {
          id: 'c1',
          content: '[KB] Plan.pdf, p.3',
          citationKey: 'Plan.pdf, p.3 (Büroarchiv)',
          fileName: 'Plan.pdf',
          collection: 'archiv_1',
          timestamp: NOW,
          kind: 'buero',
          isCited: true,
        },
      ],
    })
    const { id } = toCslItem({ document: document!, locus: document!.loci[0] }, NOW)

    expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
  })
})
