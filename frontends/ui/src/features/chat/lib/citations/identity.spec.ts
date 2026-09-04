/**
 * Identity, locator parsing, snippet extraction and preview-target resolution.
 *
 * Ported from the pre-model `answer-sources.spec.ts`: the behaviour these pin
 * did not change when the two levels were named — only where it lives — so the
 * cases come across intact. Target resolution now takes a document (+ optional
 * locus) instead of a flat citation, which is the one signature that had to
 * move with them.
 */

import { describe, test, expect } from 'vitest'
import {
  buildCitationModel,
  citationSnippet,
  oibDocumentKey,
  parseKbLocator,
  resolveCitationTarget,
  type CitationTarget,
  type StoredDocumentRef,
} from './index'
import type { GridCard } from '@/shared/cards/schemas'
import type { CitationSource } from '../../types'

const citation = (overrides: Partial<CitationSource>): CitationSource => ({
  id: 'c-1',
  url: 'https://example.com/page',
  content: 'Some cited content',
  timestamp: new Date('2026-07-17T10:00:00Z'),
  ...overrides,
})

/**
 * Resolve a target the way production does: through the real model, so these
 * cases also cover the identity and title resolution the chip depends on.
 */
const targetFor = (
  overrides: Partial<CitationSource>,
  storedDocuments?: StoredDocumentRef[],
  baseCorpusFiles?: string[]
): CitationTarget => {
  const [document] = buildCitationModel({ citations: [citation(overrides)] })
  if (!document) throw new Error('fixture produced no document')
  return resolveCitationTarget(document, {
    locus: document.loci[0],
    storedDocuments,
    baseCorpusFiles,
  })
}

describe('oibDocumentKey', () => {
  test('maps a filename and a human law label to the same canonical identity', () => {
    expect(oibDocumentKey('oib-rl_2_ausgabe_mai_2023.pdf')).toBe('oib:2')
    expect(oibDocumentKey('OIB-Richtlinie 2, Ausgabe Mai 2023')).toBe('oib:2')
    expect(oibDocumentKey('OIB RL 2')).toBe('oib:2')
  })

  test('distinguishes Richtlinie, Leitfaden, sub-numbers, and roles', () => {
    expect(oibDocumentKey('oib-rl_2.3_ausgabe_mai_2023.pdf')).toBe('oib:2.3')
    expect(oibDocumentKey('oib-rl_2_leitfaden_ausgabe_mai_2023.pdf')).toBe('oib:2:lf')
    expect(oibDocumentKey('erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf')).toBe('oib:erl:2')
    expect(oibDocumentKey('oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf')).toBe('oib:begriffe')
  })

  test('does not grab the edition year as the number', () => {
    expect(oibDocumentKey('OIB-Richtlinie 6, Ausgabe Mai 2023')).toBe('oib:6')
  })

  test('returns null for non-OIB names so their own identity is used', () => {
    expect(oibDocumentKey('Brandschutzkonzept_v3.pdf')).toBeNull()
    expect(oibDocumentKey('BO Wien §111')).toBeNull()
    expect(oibDocumentKey('')).toBeNull()
    expect(oibDocumentKey(undefined)).toBeNull()
  })
})

describe('parseKbLocator', () => {
  test('parses filename and page from a citation key', () => {
    expect(parseKbLocator('Brandschutzkonzept.pdf, p.3')).toEqual({
      filename: 'Brandschutzkonzept.pdf',
      page: 3,
    })
    expect(parseKbLocator('report.pdf, page 15')).toEqual({ filename: 'report.pdf', page: 15 })
  })

  test('parses a bare filename without page', () => {
    expect(parseKbLocator('Einreichplan.pdf')).toEqual({
      filename: 'Einreichplan.pdf',
      page: undefined,
    })
  })

  test('does not truncate filenames containing p+digits into bogus pages', () => {
    expect(parseKbLocator('Top2.pdf')).toEqual({ filename: 'Top2.pdf', page: undefined })
  })

  test('strips a leading origin token', () => {
    expect(parseKbLocator('[KB] file.pdf, p.2')).toEqual({ filename: 'file.pdf', page: 2 })
  })

  test('returns null for text that is not a document reference', () => {
    expect(parseKbLocator('Some cited sentence without a file')).toBeNull()
    expect(parseKbLocator('')).toBeNull()
  })

  test('reads the shelf out of a LEGACY qualified key and keeps the filename bare', () => {
    // Emitted only when one filename was retrieved from two collections in the
    // same turn — the qualifier is the collection half of the document's
    // identity, not part of its name. New payloads carry the shelf as data
    // (ADR-0047); this parse survives for keys already persisted in messages.
    expect(parseKbLocator('Plan.pdf (Projektwissen), p.3')).toEqual({
      filename: 'Plan.pdf',
      page: 3,
      shelf: 'project',
    })
    expect(parseKbLocator('Plan.pdf (Büroarchiv)')).toEqual({
      filename: 'Plan.pdf',
      page: undefined,
      shelf: 'archiv',
    })
  })

  test('a parenthetical that is part of the filename is left alone', () => {
    // Only the KNOWN qualifiers are stripped; trimming any trailing "(…)" would
    // rename the document and lose the citation.
    expect(parseKbLocator('Bescheid (Kopie).pdf, p.2')).toEqual({
      filename: 'Bescheid (Kopie).pdf',
      page: 2,
      shelf: undefined,
    })
  })
})

describe('citationSnippet', () => {
  test('URL-as-content (deep-research SSE shape) yields no snippet', () => {
    expect(
      citationSnippet({ url: 'https://example.com/a', content: 'https://example.com/a' })
    ).toBeUndefined()
  })

  test('a pure locator line is a reference, not a passage', () => {
    expect(citationSnippet({ url: '', content: '[KB] file.pdf, p.3' })).toBeUndefined()
  })

  test('passage lines after the locator become the snippet', () => {
    expect(
      citationSnippet({ url: '', content: '[KB] file.pdf, p.3\nDer zweite Fluchtweg …' })
    ).toBe('Der zweite Fluchtweg …')
  })

  test('plain passage text without a locator is kept', () => {
    expect(citationSnippet({ url: 'kb://x', content: 'Ein zitierter Absatz.' })).toBe(
      'Ein zitierter Absatz.'
    )
  })
})

describe('resolveCitationTarget', () => {
  const storedDocuments: StoredDocumentRef[] = [
    { id: 'doc-1', filename: 'Brandschutzkonzept.pdf', contentType: 'application/pdf' },
    {
      id: 'doc-2',
      filename: 'Vermessung.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    { id: 'doc-3', filename: 'Lageplan.png', contentType: 'image/png' },
  ]
  const baseCorpusFiles = ['oib-rl_2_ausgabe_mai_2023.pdf']

  /** An org Archiv document — a different scope, the SAME preview route. */
  const archivDocument: StoredDocumentRef = {
    id: 'archiv-1',
    filename: 'Bueroe_Detail_Attika.pdf',
    contentType: 'application/pdf',
  }

  test('http(s) URLs link out — except RIS, which Piloti reads itself', () => {
    expect(targetFor({ url: 'https://example.com/article', content: '' })).toEqual({
      kind: 'url',
      url: 'https://example.com/article',
    })
    // A RIS source resolves to the in-app reader (#622) and carries the
    // authoritative URL with it — the publication of record is never dropped,
    // it moves into the reader's header.
    expect(targetFor({ url: 'https://www.ris.bka.gv.at/Norm', content: '' })).toMatchObject({
      kind: 'ris',
      url: 'https://www.ris.bka.gv.at/Norm',
    })
  })

  test('KB locator matching a previewable project document opens it', () => {
    const target = targetFor(
      { url: '', content: '[KB] Brandschutzkonzept.pdf, p.3' },
      storedDocuments,
      baseCorpusFiles
    )

    expect(target).toEqual({
      kind: 'document',
      // The human name, not the storage filename — which travels alongside it.
      title: 'Brandschutzkonzept',
      fileName: 'Brandschutzkonzept.pdf',
      page: 3,
      snippet: undefined,
      document: {
        type: 'stored',
        id: 'doc-1',
        filename: 'Brandschutzkonzept.pdf',
        contentType: 'application/pdf',
      },
    })
  })

  test('an org Archiv document opens like any other stored document', () => {
    // The Buero (Archiv) kind used to be structurally unopenable: the preview
    // index only ever listed project uploads and the base corpus, so every
    // Archiv citation degraded to a dead info popover even though the
    // scope-aware preview route would have served it.
    const target = targetFor(
      { url: '', content: '[KB] Bueroe_Detail_Attika.pdf, p.2' },
      [...storedDocuments, archivDocument],
      baseCorpusFiles
    )

    expect(target).toMatchObject({
      kind: 'document',
      page: 2,
      document: { type: 'stored', id: 'archiv-1', filename: 'Bueroe_Detail_Attika.pdf' },
    })
  })

  test('a project upload wins over an Archiv document of the same name', () => {
    const shadowed: StoredDocumentRef = {
      id: 'archiv-2',
      filename: 'Brandschutzkonzept.pdf',
      contentType: 'application/pdf',
    }
    const target = targetFor(
      { url: '', content: '[KB] Brandschutzkonzept.pdf' },
      [...storedDocuments, shadowed],
      baseCorpusFiles
    )

    expect(target).toMatchObject({ document: { id: 'doc-1' } })
  })

  describe('a citation names its own shelf', () => {
    // Ordering ("project first") is a tie-break, not an identity. When the
    // citation CARRIES its shelf, that wins — otherwise a Büroarchiv citation
    // opens the project's unrelated file of the same name. The shelf arrives as
    // data (ADR-0047); the collection id is never prefix-matched for it.
    const shelvedDocuments: StoredDocumentRef[] = [
      { id: 'doc-1', filename: 'Plan.pdf', contentType: 'application/pdf', shelf: 'project' },
      { id: 'archiv-9', filename: 'Plan.pdf', contentType: 'application/pdf', shelf: 'archiv' },
    ]

    test('the wire shelf resolves to the Archiv copy', () => {
      const target = targetFor(
        { url: '', content: '[KB] Plan.pdf, p.2', collection: 'archiv_org1', shelf: 'archiv' },
        shelvedDocuments
      )

      expect(target).toMatchObject({ document: { id: 'archiv-9' } })
    })

    test("a LEGACY key's qualifier resolves it too, with no shelf on the wire", () => {
      const target = targetFor(
        { url: '', content: '[KB] Plan.pdf (Büroarchiv), p.2' },
        shelvedDocuments
      )

      expect(target).toMatchObject({ fileName: 'Plan.pdf', document: { id: 'archiv-9' } })
    })

    test('the project copy is still reachable', () => {
      const target = targetFor(
        { url: '', content: '[KB] Plan.pdf, p.2', collection: 'proj_alpha', shelf: 'project' },
        shelvedDocuments
      )

      expect(target).toMatchObject({ document: { id: 'doc-1' } })
    })

    test('a shelf holding no such document is UNAVAILABLE, never another shelf’s copy', () => {
      // The shelf is part of the document's identity (ADR-0047), so it is not
      // negotiable: a `base` citation whose shelf holds no `Plan.pdf` must say
      // so, not open the project's unrelated file of the same name. Failing
      // OPEN here meant a citation could be honestly labelled "Basiswissen" and
      // then show a project upload.
      const target = targetFor(
        { url: '', content: '[KB] Plan.pdf, p.2', collection: 'oib_knowledge', shelf: 'base' },
        shelvedDocuments
      )

      expect(target).toMatchObject({ kind: 'info' })
    })

    test('a session citation does not open the project copy of the same name', () => {
      // The `session` shelf is the case that made this concrete: before the
      // session list existed, `storedDocuments` held no session row at all, so
      // every private attachment fell through to the project document beside it.
      const target = targetFor(
        { url: '', content: '[KB] Plan.pdf, p.2', collection: 's_conv1', shelf: 'session' },
        shelvedDocuments
      )

      expect(target).toMatchObject({ kind: 'info' })
    })

    test('a session citation opens the session copy once that shelf is listed', () => {
      const target = targetFor(
        { url: '', content: '[KB] Plan.pdf, p.2', collection: 's_conv1', shelf: 'session' },
        [
          ...shelvedDocuments,
          { id: 'sess-3', filename: 'Plan.pdf', contentType: 'application/pdf', shelf: 'session' },
        ]
      )

      expect(target).toMatchObject({ kind: 'document', document: { id: 'sess-3' } })
    })

    test('a stored-shelf citation does not slide onto a base-corpus file either', () => {
      // The corpus is the `base` shelf. An `archiv` citation naming a filename
      // the corpus also carries must not be answered with the corpus copy.
      const target = targetFor(
        { url: '', content: '[KB] Handbuch.pdf, p.2', shelf: 'archiv' },
        shelvedDocuments,
        ['Handbuch.pdf']
      )

      expect(target).toMatchObject({ kind: 'info' })
    })

    test('a collection id no longer decides the shelf on its own', () => {
      // The prefix table is gone: `archiv_org1` with no shelf on the wire is an
      // UNKNOWN shelf, which resolves by filename alone (project first) rather
      // than by a guess. This is the fail-open inference ADR-0047 deletes.
      const target = targetFor(
        { url: '', content: '[KB] Plan.pdf, p.2', collection: 'archiv_org1' },
        shelvedDocuments
      )

      expect(target).toMatchObject({ document: { id: 'doc-1' } })
    })

    test('a base-shelf citation opens the base corpus, not a same-named upload', () => {
      // The base corpus has no StoredDocumentRef row, so `base` was the one shelf
      // that resolved to the wrong document whenever a project upload shared the
      // filename.
      const target = targetFor(
        { url: '', content: '[KB] Plan.pdf, p.2', shelf: 'base' },
        shelvedDocuments,
        ['Plan.pdf']
      )

      expect(target).toMatchObject({ document: { type: 'base', fileName: 'Plan.pdf' } })
    })

    test('a legacy Basiswissen key opens the base corpus too', () => {
      const target = targetFor(
        { url: '', content: '[KB] Plan.pdf (Basiswissen), p.2' },
        shelvedDocuments,
        ['Plan.pdf']
      )

      expect(target).toMatchObject({ document: { type: 'base', fileName: 'Plan.pdf' } })
    })

    test('a base-shelf citation with no base-corpus copy is UNAVAILABLE', () => {
      // `base` is the one shelf `storedDocuments` can never represent, so there
      // is no second place to look — and a same-named project upload is not it.
      const target = targetFor(
        { url: '', content: '[KB] Plan.pdf, p.2', shelf: 'base' },
        shelvedDocuments,
        ['oib-rl_2.pdf']
      )

      expect(target).toMatchObject({ kind: 'info' })
    })

    test('untagged rows still resolve for callers that supply no shelf', () => {
      // A row the caller never tagged states no shelf, so it CONTRADICTS none:
      // it is not evidence of a different shelf, which is the only thing the
      // narrowing above rejects. Refusing these would break every caller that
      // passes a plain list.
      const target = targetFor(
        { url: '', content: '[KB] Brandschutzkonzept.pdf', shelf: 'project' },
        storedDocuments
      )

      expect(target).toMatchObject({ document: { id: 'doc-1' } })
    })
  })

  test('project filename matching is case-insensitive', () => {
    const target = targetFor({ url: '', content: '[KB] brandschutzkonzept.PDF' }, storedDocuments)

    expect(target.kind).toBe('document')
  })

  test('image project documents are previewable', () => {
    const target = targetFor({ url: '', content: '[KB] Lageplan.png' }, storedDocuments)

    expect(target).toMatchObject({
      kind: 'document',
      document: { type: 'stored', id: 'doc-3', contentType: 'image/png' },
    })
  })

  test('a non-previewable project document is offered as a download, never as a broken viewer', () => {
    // It used to degrade to `info`, which said nothing and offered nothing —
    // and the reader concluded the product had lost their file (#623). It had
    // not; it cannot DRAW a .docx. The two are different answers.
    const target = targetFor(
      { url: '', content: '[KB] Vermessung.docx' },
      storedDocuments,
      baseCorpusFiles
    )

    expect(target).toEqual({
      kind: 'download',
      title: 'Vermessung',
      fileName: 'Vermessung.docx',
      snippet: undefined,
      document: {
        type: 'stored',
        id: 'doc-2',
        filename: 'Vermessung.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    })
  })

  test('a citation that resolves to no document at all is still info', () => {
    const target = targetFor(
      { url: '', content: '[KB] Nirgendwo.docx' },
      storedDocuments,
      baseCorpusFiles
    )

    expect(target).toEqual({ kind: 'info', title: 'Nirgendwo', snippet: undefined })
  })

  test('KB locator matching a base-corpus PDF opens the corpus viewer', () => {
    const target = targetFor(
      { url: '', content: '[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.12' },
      storedDocuments,
      baseCorpusFiles
    )

    expect(target).toEqual({
      kind: 'document',
      // The Richtlinie's real name — a corpus filename is storage identity and
      // must never be what a user reads.
      title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
      fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
      page: 12,
      snippet: undefined,
      document: { type: 'base', fileName: 'oib-rl_2_ausgabe_mai_2023.pdf' },
    })
  })

  test('a pseudo-URL basename resolves when the content carries no locator', () => {
    const target = targetFor({ url: 'kb://Brandschutzkonzept.pdf', content: '' }, storedDocuments)

    expect(target).toMatchObject({ kind: 'document', document: { id: 'doc-1' } })
  })

  test('unresolvable citations become info with title and snippet', () => {
    const target = targetFor(
      { url: '', content: '[KB] unbekannt.pdf, p.4\nZitierter Absatz.' },
      storedDocuments,
      baseCorpusFiles
    )

    expect(target).toEqual({
      kind: 'info',
      title: 'Unbekannt',
      snippet: 'Zitierter Absatz.',
    })
  })

  test('without document lists everything degrades to info', () => {
    const target = targetFor({ url: '', content: '[KB] Brandschutzkonzept.pdf' })

    expect(target.kind).toBe('info')
  })
})

/**
 * The canonical OIB key is a MERGE HINT, not an identity.
 *
 * It deliberately discards edition, revision and everything after the number,
 * which is right for the one thing it is for — joining a `legal_basis` card
 * that knows only „OIB-Richtlinie 2" to the citation of that Richtlinie — and
 * catastrophic as an identity: every document whose name merely mentions OIB or
 * "Richtlinie" was identified by its number alone.
 */
describe('two documents are not one because their names share a Richtlinie', () => {
  const corpusHit = (fileName: string, page: number): CitationSource =>
    citation({
      url: '',
      content: `${fileName}, p.${page}`,
      fileName,
      citationKey: `${fileName}, p.${page}`,
      collection: 'oib_knowledge',
      shelf: 'base',
      page,
      isCited: true,
    })

  test('a corpus list and its Rev. 1 stay two documents', () => {
    // Both ship in `data/oib/`. They are two different tables of normative
    // references, and they collapsed into one — so a citation to Rev. 1 at
    // p. 14 opened the superseded list at p. 14, with nothing on screen
    // suggesting the reader was looking at the wrong document.
    const base = 'oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023.pdf'
    const rev =
      'oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023_rev.1.pdf'

    const docs = buildCitationModel({ citations: [corpusHit(base, 3), corpusHit(rev, 14)] })

    expect(docs).toHaveLength(2)
    expect(docs.map((doc) => doc.fileName).sort()).toEqual([base, rev].sort())
  })

  test('a project upload that mentions a Richtlinie is not swallowed by the corpus', () => {
    // The cross-shelf half, and the worse one: the reader's own document did
    // not merely get mislabelled, it disappeared from the answer — one chip,
    // the corpus filename, the base shelf — while its page carried on pointing
    // into the Richtlinie. That is the collapse ADR-0047 exists to prevent.
    const docs = buildCitationModel({
      citations: [
        corpusHit('oib-rl_6_ausgabe_mai_2023.pdf', 2),
        citation({
          url: '',
          content: 'OIB-Richtlinie 6 Kommentar.pdf, p.9',
          fileName: 'OIB-Richtlinie 6 Kommentar.pdf',
          citationKey: 'OIB-Richtlinie 6 Kommentar.pdf, p.9',
          collection: 'proj_1',
          shelf: 'project',
          page: 9,
          isCited: true,
        }),
      ],
    })

    expect(docs).toHaveLength(2)
    expect(docs.map((doc) => doc.shelf).sort()).toEqual(['base', 'project'])
  })

  test('the merge the key IS for still happens: a card joins its Richtlinie', () => {
    const card = { type: 'legal_basis', law: 'OIB-Richtlinie 6' } as unknown as GridCard
    const docs = buildCitationModel({
      citations: [corpusHit('oib-rl_6_ausgabe_mai_2023.pdf', 2)],
      cards: [card],
    })

    expect(docs).toHaveLength(1)
    expect(docs[0]!.fileName).toBe('oib-rl_6_ausgabe_mai_2023.pdf')
  })

  test('but a card never attaches itself to a non-base document', () => {
    // A Richtlinie is base law. A card naming one must not bind to a project
    // upload or a private attachment that merely mentions it.
    const card = { type: 'legal_basis', law: 'OIB-Richtlinie 6' } as unknown as GridCard
    const docs = buildCitationModel({
      citations: [
        citation({
          url: '',
          content: 'OIB-Richtlinie 6 Kommentar.pdf, p.9',
          fileName: 'OIB-Richtlinie 6 Kommentar.pdf',
          citationKey: 'OIB-Richtlinie 6 Kommentar.pdf, p.9',
          collection: 'proj_1',
          shelf: 'project',
          page: 9,
          isCited: true,
        }),
      ],
      cards: [card],
    })

    expect(docs).toHaveLength(2)
  })

  test('a written-list-only OIB source still renders as one', () => {
    // The lane inference used to be read off the identity, which no longer
    // starts with `oib:` for a document that names a file.
    const [doc] = buildCitationModel({
      entries: [{ number: 1, markdown: '[KB] oib-rl_2.1_ausgabe_mai_2023.pdf, p.9' }],
    })

    expect(doc!.lane).toBe('baurecht_oib')
    expect(doc!.authority).toBe('OIB')
  })
})
