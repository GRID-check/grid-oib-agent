/**
 * Where a clicked citation lands, and what a resolved-but-unrenderable one
 * offers. Three behaviours the provenance row depends on:
 *
 *  - the viewer opens at the page a citation knows, not at page 1;
 *  - a cited project document offers a way in and a reason, not nothing;
 *  - a RIS source opens in the app instead of leaving it.
 */

import { describe, expect, test } from 'vitest'
import { buildCitationModel, openAtLocus, referencesByNumber, resolveCitationTarget } from './index'
import type { CitationSource } from '../../types'

const wire = (overrides: Partial<CitationSource>): CitationSource => ({
  id: `c-${Math.random()}`,
  content: '',
  timestamp: new Date('2026-09-04T10:00:00Z'),
  ...overrides,
})

/**
 * The shape a citation arrives in: the retrieval payload knows the page, the
 * answer's written source list carries the `[N]` and names no page. Two loci,
 * one document.
 */
const officeDocument = () => {
  const [document] = buildCitationModel({
    citations: [
      wire({
        fileName: 'Sockeldetail_Holzmassivbau.pdf',
        title: 'Sockeldetail Holzmassivbau',
        shelf: 'archiv',
        page: 18,
        citationKey: 'Sockeldetail_Holzmassivbau.pdf, p.18',
        isCited: true,
      }),
    ],
    entries: [
      {
        number: 1,
        markdown: 'Sockeldetail_Holzmassivbau.pdf (Büroarchiv)',
      },
    ],
  })
  if (!document) throw new Error('fixture produced no document')
  return document
}

describe('a citation opens where the document was read', () => {
  test('the document carries both a located and a page-less locus', () => {
    const document = officeDocument()
    expect(document.loci.some((locus) => locus.page === 18)).toBe(true)
    expect(document.loci.some((locus) => locus.page === undefined)).toBe(true)
  })

  test('a page-less locus never decides the page while the document knows one', () => {
    const document = officeDocument()
    const pageless = document.loci.find((locus) => locus.page === undefined)!

    // The reader presses the `[1]` whose binding came from the written list, and
    // the viewer must open at the page the retrieval payload names, not at page 1.
    expect(openAtLocus(document, pageless)?.page).toBe(18)

    const target = resolveCitationTarget(document, {
      locus: pageless,
      storedDocuments: [
        {
          id: 'doc-1',
          filename: 'Sockeldetail_Holzmassivbau.pdf',
          contentType: 'application/pdf',
          shelf: 'archiv',
        },
      ],
    })
    expect(target).toMatchObject({ kind: 'document', page: 18 })
  })

  test('a document genuinely read nowhere in particular still opens at its start', () => {
    const [document] = buildCitationModel({
      citations: [wire({ fileName: 'Notiz.pdf', title: 'Notiz', shelf: 'project', isCited: true })],
    })
    expect(openAtLocus(document!)?.page).toBeUndefined()
  })

  test('a locus that carries the cited passage keeps it, and keeps its own words', () => {
    // Treating "has a page" as the test would discard `[3]`'s locus for `[5]`'s.
    // `[3]` cites the document as a whole WITH the quoted passage; `[5]` is a
    // different passage on page 7. The reader would click `[3]` and be shown page 7
    // with ANOTHER citation's sentence marked as theirs, and the copy-as-Zitat and
    // the deep link would inherit it.
    const [document] = buildCitationModel({
      citations: [
        wire({
          fileName: 'Gutachten.pdf',
          title: 'Gutachten',
          shelf: 'project',
          citationKey: 'Gutachten.pdf',
          snippet: 'DIE STELLE AUF DIE SICH DIE ANTWORT BEI [3] BEZIEHT',
          number: 3,
          isCited: true,
        }),
        wire({
          fileName: 'Gutachten.pdf',
          title: 'Gutachten',
          shelf: 'project',
          page: 7,
          citationKey: 'Gutachten.pdf, p.7',
          snippet: 'EINE ANDERE STELLE, AUF SEITE SIEBEN',
          number: 5,
          isCited: true,
        }),
      ],
    })
    const forThree = referencesByNumber([document!]).get(3)!.locus!

    // A passage IS a place — the viewer finds it without being told a page.
    expect(openAtLocus(document!, forThree)?.key).toBe(forThree.key)

    const target = resolveCitationTarget(document!, {
      locus: forThree,
      storedDocuments: [
        { id: 'g1', filename: 'Gutachten.pdf', contentType: 'application/pdf', shelf: 'project' },
      ],
    })
    expect(target).toMatchObject({
      kind: 'document',
      snippet: 'DIE STELLE AUF DIE SICH DIE ANTWORT BEI [3] BEZIEHT',
    })
    expect(target).not.toMatchObject({ page: 7 })
  })

  test("a place may be borrowed, but the caller's passage never is", () => {
    // The other half: a locus with NEITHER page nor passage still borrows a
    // page from the document, and must not acquire that locus's words with it.
    const document = officeDocument()
    const pageless = document.loci.find((locus) => locus.page === undefined)!
    document.loci.find((locus) => locus.page === 18)!.snippet = 'SEITE ACHTZEHN'

    const target = resolveCitationTarget(document, {
      locus: pageless,
      storedDocuments: [
        {
          id: 'doc-1',
          filename: 'Sockeldetail_Holzmassivbau.pdf',
          contentType: 'application/pdf',
          shelf: 'archiv',
        },
      ],
    })
    // The page is borrowed from the document…
    expect(target).toMatchObject({ kind: 'document', page: 18 })
    // …and since the asked locus has no passage of its own, the borrowed one is
    // all there is. It belongs to the same place, so it is not a false claim.
    expect(target).toMatchObject({ snippet: 'SEITE ACHTZEHN' })
  })

  test('an explicit locus that names its own page is never second-guessed', () => {
    const document = officeDocument()
    const located = document.loci.find((locus) => locus.page === 18)!
    expect(openAtLocus(document, located)?.page).toBe(18)
  })
})

describe('a cited document with no viewer says so and hands over the file', () => {
  const cited = (fileName: string, page?: number) => {
    const [document] = buildCitationModel({
      citations: [
        wire({
          fileName,
          title: fileName.replace(/\.[^.]+$/, ''),
          shelf: 'project',
          page,
          isCited: true,
        }),
      ],
    })
    return document!
  }

  test('resolves to a download rather than to a dead info popover', () => {
    const target = resolveCitationTarget(cited('Bestandsplan_EG.dwg'), {
      storedDocuments: [
        {
          id: 'doc-9',
          filename: 'Bestandsplan_EG.dwg',
          contentType: 'image/vnd.dwg',
          shelf: 'project',
        },
      ],
    })

    expect(target).toMatchObject({
      kind: 'download',
      fileName: 'Bestandsplan_EG.dwg',
      document: { type: 'stored', id: 'doc-9' },
    })
  })

  test('a citation that resolves to nothing is still `info`, not a download', () => {
    // The distinction is the whole point: "we cannot draw it" and "it is not
    // here" are different answers and the reader is owed the right one.
    const target = resolveCitationTarget(cited('Bestandsplan_EG.dwg'), { storedDocuments: [] })
    expect(target.kind).toBe('info')
  })

  test('a previewable document still opens in the viewer', () => {
    const target = resolveCitationTarget(cited('Raumprogramm_Schulbau.docx'), {
      storedDocuments: [
        {
          id: 'doc-9',
          filename: 'Raumprogramm_Schulbau.docx',
          contentType: 'application/pdf',
          shelf: 'project',
        },
      ],
    })
    expect(target.kind).toBe('document')
  })
})

describe('a cited office document opens on its PDF rendition (ADR-0070)', () => {
  const cited = (fileName: string, page?: number) => {
    const [document] = buildCitationModel({
      citations: [
        wire({
          fileName,
          title: fileName.replace(/\.[^.]+$/, ''),
          shelf: 'project',
          page,
          isCited: true,
        }),
      ],
    })
    return document!
  }
  const stored = (filename: string, contentType: string | null) => [
    { id: 'doc-9', filename, contentType, shelf: 'project' as const },
  ]

  test('a Word file is a `document`, not a download, and keeps its original type', () => {
    // The BFF renders a PDF from a Word file, so it opens as a `document`. The
    // surface falls back to the download only when that rendition cannot be had
    // (415 / 502).
    const target = resolveCitationTarget(cited('Raumprogramm_Schulbau.docx', 1), {
      storedDocuments: stored(
        'Raumprogramm_Schulbau.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ),
    })
    expect(target).toMatchObject({
      kind: 'document',
      page: 1,
      document: {
        type: 'stored',
        id: 'doc-9',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    })
  })

  test('the extension alone is enough when the stored type is empty', () => {
    const target = resolveCitationTarget(cited('Kostenschaetzung.xlsx'), {
      storedDocuments: stored('Kostenschaetzung.xlsx', null),
    })
    expect(target.kind).toBe('document')
  })

  test('a slide number is the rendition page: one PDF page per slide', () => {
    for (const fileName of ['Praesentation.pptx', 'Praesentation.pptm', 'Alt.ppt', 'Vortrag.odp']) {
      const target = resolveCitationTarget(cited(fileName, 7), {
        storedDocuments: stored(fileName, null),
      })
      expect(target, fileName).toMatchObject({ kind: 'document', page: 7 })
    }
  })

  test('a Word locus page is a rendition page, because the chunks were read from it (ADR-0071)', () => {
    for (const fileName of ['Baubeschreibung.docx', 'Makro.docm', 'Alt.doc', 'Notiz.odt', 'Brief.rtf']) {
      const target = resolveCitationTarget(cited(fileName, 4), {
        storedDocuments: stored(fileName, null),
      })
      expect(target, fileName).toMatchObject({ kind: 'document', page: 4 })
    }
  })

  test('a spreadsheet with no extractor of its own is indexed from the rendition too', () => {
    for (const fileName of ['Alt.xls', 'Tabelle.ods']) {
      const target = resolveCitationTarget(cited(fileName, 3), {
        storedDocuments: stored(fileName, null),
      })
      expect(target, fileName).toMatchObject({ kind: 'document', page: 3 })
    }
  })

  test('an .xlsx or .xlsm locus names a sheet, not a rendition page, so it opens at 1', () => {
    // openpyxl still reads these from the original; one sheet can print across
    // many PDF pages, so the sheet number says nothing about where it lands.
    for (const fileName of ['Flaechen.xlsx', 'Makro.xlsm']) {
      const target = resolveCitationTarget(cited(fileName, 4), {
        storedDocuments: stored(fileName, null),
      })
      expect(target, fileName).toMatchObject({ kind: 'document', page: 1 })
    }
  })

  test('a locus page that is not a whole positive number opens at 1', () => {
    for (const page of [0, -2, 2.5]) {
      const target = resolveCitationTarget(cited('Baubeschreibung.docx', page), {
        storedDocuments: stored('Baubeschreibung.docx', null),
      })
      expect(target, String(page)).toMatchObject({ kind: 'document', page: 1 })
    }
  })

  test('a slide deck cited with no slide opens at 1', () => {
    const target = resolveCitationTarget(cited('Praesentation.pptx'), {
      storedDocuments: stored('Praesentation.pptx', null),
    })
    expect(target).toMatchObject({ kind: 'document', page: 1 })
  })
})

describe('a RIS source opens inside Piloti', () => {
  const risCitation = (url: string) => {
    const [document] = buildCitationModel({
      citations: [
        wire({
          url,
          title: 'Arbeitsstättenverordnung § 22',
          origin: 'ris',
          isCited: true,
          content: 'Arbeitsstättenverordnung § 22',
        }),
      ],
    })
    return document!
  }

  test('resolves to the reader, carrying the authoritative URL with it', () => {
    const url =
      'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20001234'
    expect(resolveCitationTarget(risCitation(url))).toMatchObject({ kind: 'ris', url })
  })

  test('every other web source keeps linking out', () => {
    const url = 'https://example.org/leitfaden'
    expect(resolveCitationTarget(risCitation(url))).toEqual({ kind: 'url', url })
  })
})

describe('an inline `[N]` binds to the locus that knows its page', () => {
  test('the written list cannot take the page away from the retrieval payload', () => {
    // Both producers state `[1]`: the wire knows the page, the written list does
    // not. Two loci, one marker — and `byNumber` must keep the located one, not
    // whichever comes last in locus order, which is the page-less one.
    const [document] = buildCitationModel({
      citations: [
        wire({
          fileName: 'Sockeldetail_Holzmassivbau.pdf',
          title: 'Sockeldetail Holzmassivbau',
          shelf: 'archiv',
          page: 18,
          number: 1,
          citationKey: 'Sockeldetail_Holzmassivbau.pdf, p.18',
          isCited: true,
        }),
      ],
      entries: [{ number: 1, markdown: 'Sockeldetail_Holzmassivbau.pdf (Büroarchiv)' }],
    })
    const bound = referencesByNumber([document!]).get(1)

    expect(bound?.document.id).toBe(document!.id)
    expect(bound?.locus?.page).toBe(18)
  })

  test('a marker bound to a page-less locus still opens where the document was read', () => {
    // The other half of the same case: when only the written list carries
    // `[1]`, the binding is honestly page-less and the fix has to happen at the
    // open instead.
    const document = officeDocument()
    const bound = referencesByNumber([document]).get(1)

    expect(bound?.locus?.page).toBeUndefined()
    expect(openAtLocus(document, bound?.locus)?.page).toBe(18)
  })

  test('a marker whose document names no page at all still resolves', () => {
    const [document] = buildCitationModel({
      entries: [{ number: 2, markdown: 'Bauordnung für Wien § 108' }],
    })
    expect(referencesByNumber([document!]).get(2)?.document.id).toBe(document!.id)
  })
})
