import { describe, test, expect, vi } from 'vitest'
import { toCslItem, toFachtext, toFachtextList } from './source-citation'
import { renderCitations } from './citation-export'
import { renderCitations as renderOnServer } from '@/lib/citations/render'
import type { AnswerSourceItem } from './answer-source-list'

const NOW = new Date('2026-07-28T12:00:00Z')

const oib: AnswerSourceItem = {
  key: 'c1',
  number: 1,
  page: 18,
  ref: {
    key: 'c1',
    label: 'OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023',
    kind: 'kb',
    signal: 'oib',
    authority: 'OIB',
    number: 1,
    citation: {
      id: 'c1',
      content: '',
      timestamp: NOW,
      fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
      lane: 'baurecht_oib',
      page: 18,
    },
  },
}

const law: AnswerSourceItem = {
  key: 'c2',
  number: 2,
  host: 'ris.bka.gv.at',
  ref: {
    key: 'c2',
    label: 'Bauordnung für Wien § 108',
    kind: 'ris',
    signal: 'law',
    authority: 'RIS',
    url: 'https://www.ris.bka.gv.at/x',
    number: 2,
    citation: {
      id: 'c2',
      content: '',
      timestamp: NOW,
      lane: 'baurecht_ris',
      laneLabel: 'Rechtsquelle (RIS)',
      url: 'https://www.ris.bka.gv.at/x',
    },
  },
}

const projectDoc: AnswerSourceItem = {
  key: 'c3',
  number: 3,
  page: 2,
  ref: {
    key: 'c3',
    label: 'Grundriss EG',
    kind: 'kb',
    signal: 'project',
    number: 3,
    citation: {
      id: 'c3',
      content: '',
      timestamp: NOW,
      fileName: 'Grundriss_EG.pdf',
      page: 2,
    },
  },
}

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
    const csl = toCslItem(
      { ...oib, ref: { ...oib.ref, label: 'OIB-Richtlinie 2 – Brandschutz', citation: undefined } },
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
