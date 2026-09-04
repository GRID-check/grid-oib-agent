/**
 * Where a clicked citation lands, and what a resolved-but-unrenderable one
 * offers — the three defects reported against the answer's provenance row.
 *
 *  - #621 the viewer opened at page 1 for a citation that knew its page;
 *  - #623 a cited project document offered no way in and no reason;
 *  - #622 a RIS source left the product instead of opening in it.
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
 * The shape #621 arrives in: the retrieval payload knows the page, the answer's
 * written source list carries the `[N]` and names no page. Two loci, one
 * document.
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

describe('a citation opens where the document was read (#621)', () => {
  test('the document carries both a located and a page-less locus', () => {
    const document = officeDocument()
    expect(document.loci.some((locus) => locus.page === 18)).toBe(true)
    expect(document.loci.some((locus) => locus.page === undefined)).toBe(true)
  })

  test('a page-less locus never decides the page while the document knows one', () => {
    const document = officeDocument()
    const pageless = document.loci.find((locus) => locus.page === undefined)!

    // This is the click #621 reported: the reader pressed the `[1]` whose
    // binding came from the written list, and the viewer opened at page 1.
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

  test('an explicit locus that names its own page is never second-guessed', () => {
    const document = officeDocument()
    const located = document.loci.find((locus) => locus.page === 18)!
    expect(openAtLocus(document, located)?.page).toBe(18)
  })
})

describe('a cited document with no viewer says so and hands over the file (#623)', () => {
  const raumprogramm = () => {
    const [document] = buildCitationModel({
      citations: [
        wire({
          fileName: 'Raumprogramm_Schulbau.docx',
          title: 'Raumprogramm Schulbau',
          shelf: 'project',
          isCited: true,
        }),
      ],
    })
    return document!
  }

  test('resolves to a download rather than to a dead info popover', () => {
    const target = resolveCitationTarget(raumprogramm(), {
      storedDocuments: [
        {
          id: 'doc-9',
          filename: 'Raumprogramm_Schulbau.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          shelf: 'project',
        },
      ],
    })

    expect(target).toMatchObject({
      kind: 'download',
      fileName: 'Raumprogramm_Schulbau.docx',
      document: { type: 'stored', id: 'doc-9' },
    })
  })

  test('a citation that resolves to nothing is still `info`, not a download', () => {
    // The distinction is the whole point: "we cannot draw it" and "it is not
    // here" are different answers and the reader is owed the right one.
    const target = resolveCitationTarget(raumprogramm(), { storedDocuments: [] })
    expect(target.kind).toBe('info')
  })

  test('a previewable document still opens in the viewer', () => {
    const target = resolveCitationTarget(raumprogramm(), {
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

describe('a RIS source opens inside Piloti (#622)', () => {
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

describe('an inline `[N]` binds to the locus that knows its page (#621)', () => {
  test('the written list cannot take the page away from the retrieval payload', () => {
    // Both producers state `[1]`: the wire knows the page, the written list
    // does not. Two loci, one marker — and `byNumber` used to keep whichever
    // came last in locus order, which is the page-less one.
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
    // The other half of the same defect: when only the written list carries
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
