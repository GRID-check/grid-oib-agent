import { describe, test, expect } from 'vitest'
import {
  citationSnippet,
  deriveAnswerSources,
  oibDocumentKey,
  parseKbLocator,
  resolveCitationTarget,
  type StoredDocumentRef,
} from './answer-sources'
import type { CitationSource } from '../types'
import type { GridCard } from '@/shared/cards/schemas'

const citation = (overrides: Partial<CitationSource>): CitationSource => ({
  id: 'c-1',
  url: 'https://example.com/page',
  content: 'Some cited content',
  timestamp: new Date('2026-07-17T10:00:00Z'),
  ...overrides,
})

describe('deriveAnswerSources', () => {
  test('returns nothing when the message carries no source data', () => {
    expect(deriveAnswerSources(undefined, undefined)).toEqual([])
    expect(deriveAnswerSources([], [])).toEqual([])
  })

  test('classifies origins from the backend token first', () => {
    const sources = deriveAnswerSources([
      citation({ id: 'c-1', url: 'https://example.com/a', content: '[KB] Brandschutzkonzept.pdf' }),
      citation({ id: 'c-2', url: 'https://example.com/b', content: '[RIS] BO Wien §111' }),
      citation({ id: 'c-3', url: 'https://example.com/c', content: '[Web] Some article' }),
    ])

    expect(sources.map((s) => s.kind)).toEqual(['kb', 'ris', 'web'])
  })

  test('falls back to URL heuristics without a token', () => {
    const sources = deriveAnswerSources([
      citation({ id: 'c-1', url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=1' }),
      citation({ id: 'c-2', url: 'https://example.com/article' }),
      citation({ id: 'c-3', url: 'doc://brandschutz.pdf', content: 'Brandschutzkonzept.pdf' }),
    ])

    expect(sources.map((s) => s.kind)).toEqual(['ris', 'web', 'kb'])
  })

  test('labels http sources with their hostname and links them', () => {
    const [source] = deriveAnswerSources([
      citation({ url: 'https://www.example.com/deep/path' }),
    ])

    expect(source.label).toBe('example.com')
    expect(source.url).toBe('https://www.example.com/deep/path')
  })

  test('non-http sources get no outbound link', () => {
    const [source] = deriveAnswerSources([
      citation({ url: 'kb://doc-1', content: '[KB] Einreichplan.pdf' }),
    ])

    expect(source.url).toBeUndefined()
    expect(source.label).toBe('Einreichplan.pdf')
  })

  test('prefers actually-cited sources when the flag is present', () => {
    const sources = deriveAnswerSources([
      citation({ id: 'c-1', url: 'https://a.example.com', isCited: false }),
      citation({ id: 'c-2', url: 'https://b.example.com', isCited: true }),
    ])

    expect(sources).toHaveLength(1)
    expect(sources[0].label).toBe('b.example.com')
  })

  test('uses all citations when none carry the cited flag (older messages)', () => {
    const sources = deriveAnswerSources([
      citation({ id: 'c-1', url: 'https://a.example.com' }),
      citation({ id: 'c-2', url: 'https://b.example.com' }),
    ])

    expect(sources).toHaveLength(2)
  })

  test('deduplicates by URL', () => {
    const sources = deriveAnswerSources([
      citation({ id: 'c-1', url: 'https://a.example.com/x' }),
      citation({ id: 'c-2', url: 'https://a.example.com/x' }),
    ])

    expect(sources).toHaveLength(1)
  })

  test('derives law chips from legal_basis cards (shallow answers)', () => {
    const cards = [
      {
        type: 'legal_basis',
        law: 'OIB-Richtlinie 2',
        section: 'Pkt. 5.1.1',
        article: null,
        original_text: null,
        summary: null,
      },
    ] as GridCard[]

    const sources = deriveAnswerSources(undefined, cards)

    expect(sources).toHaveLength(1)
    expect(sources[0].kind).toBe('ris')
    expect(sources[0].label).toBe('OIB-Richtlinie 2 Pkt. 5.1.1')
  })

  test('colors by the canonical wire kind, refined by lane: OIB and RIS are distinguishable', () => {
    const sources = deriveAnswerSources([
      citation({ id: 'c-1', url: undefined, content: '[KB] oib-rl_2.pdf, p.5', kind: 'baurecht', lane: 'baurecht_oib' }),
      citation({ id: 'c-2', url: 'https://www.ris.bka.gv.at/Norm', kind: 'baurecht', lane: 'baurecht_ris' }),
      citation({ id: 'c-3', url: undefined, content: 'plan.pdf', kind: 'projekt', lane: 'projekt' }),
    ])

    // Both remain Baurecht (same `kind`, same scales glyph), but the OIB
    // corpus paints with the `oib` accent so a fan-out of OIB + RIS is
    // readable by colour and does not lean on the badge text alone.
    expect(sources.map((s) => s.signal)).toEqual(['oib', 'law', 'project'])
    expect(sources.map((s) => s.authority)).toEqual(['OIB', 'RIS', undefined])
  })

  test('falls back to the legacy origin→signal map for pre-kind messages (kb → project)', () => {
    const [source] = deriveAnswerSources([
      citation({ url: undefined, content: '[KB] Einreichplan.pdf' }),
    ])

    expect(source.signal).toBe('project')
    expect(source.authority).toBeUndefined()
  })

  test('legal_basis chips render in the Baurecht family with an authority tag', () => {
    const cards = [
      { type: 'legal_basis', law: 'OIB-Richtlinie 2', section: 'Pkt. 5.1.1', article: null, original_text: null, summary: null },
    ] as GridCard[]

    const [source] = deriveAnswerSources(undefined, cards)

    // A legal_basis card naming a Richtlinie is OIB, so it must match the OIB
    // citation chip it dedupes against — one colour per document identity.
    expect(source.signal).toBe('oib')
    expect(source.authority).toBe('OIB')
  })

  test('caps the row at 8 chips', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      citation({ id: `c-${i}`, url: `https://host-${i}.example.com` })
    )

    expect(deriveAnswerSources(many)).toHaveLength(8)
  })

  test('citation refs carry the underlying citation for preview resolution', () => {
    const source = citation({ url: 'kb://doc-1', content: '[KB] Einreichplan.pdf' })
    const [ref] = deriveAnswerSources([source])

    expect(ref.citation).toBe(source)
  })

  test('legal_basis refs carry the original text as snippet', () => {
    const cards = [
      {
        type: 'legal_basis',
        law: 'OIB-Richtlinie 2',
        section: 'Pkt. 5.1.1',
        article: null,
        original_text: 'Der zweite Fluchtweg ist …',
        summary: 'Zusammenfassung',
      },
    ] as GridCard[]

    const [ref] = deriveAnswerSources(undefined, cards)

    expect(ref.citation).toBeUndefined()
    expect(ref.snippet).toBe('Der zweite Fluchtweg ist …')
  })

  test('collapses a KB citation and a legal_basis card for the SAME OIB document into one chip', () => {
    // The exact reported bug: one document reaching the row via both streams —
    // the KB citation (filename identity) and the legal_basis card (law name).
    const citations = [
      citation({
        id: 'c-1',
        url: undefined,
        content: '[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.5',
        fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
        title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
        kind: 'baurecht',
        lane: 'baurecht_oib',
        isCited: true,
      }),
    ]
    const cards = [
      { type: 'legal_basis', law: 'OIB-Richtlinie 2 Ausgabe Mai 2023', section: 'Pkt. 3.1' },
    ] as GridCard[]

    const sources = deriveAnswerSources(citations, cards)

    expect(sources).toHaveLength(1)
    // The surviving chip is the citation — it shows the display name (never the
    // raw filename) and stays openable to the real PDF.
    expect(sources[0].label).toBe('OIB-Richtlinie 2, Ausgabe Mai 2023')
    expect(sources[0].citation?.fileName).toBe('oib-rl_2_ausgabe_mai_2023.pdf')
  })

  test('keeps a legal_basis card that names a DIFFERENT OIB document than the citation', () => {
    const citations = [
      citation({
        id: 'c-1',
        url: undefined,
        content: '[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.5',
        fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
        kind: 'baurecht',
        lane: 'baurecht_oib',
        isCited: true,
      }),
    ]
    // A Leitfaden is a distinct document from the Richtlinie → two chips.
    const cards = [{ type: 'legal_basis', law: 'OIB-Richtlinie 2 Leitfaden' }] as GridCard[]

    expect(deriveAnswerSources(citations, cards)).toHaveLength(2)
  })
})

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

  test('reads the shelf out of a qualified key and keeps the filename bare', () => {
    // Emitted only when one filename was retrieved from two collections in the
    // same turn — the qualifier is the collection half of the document's
    // identity, not part of its name.
    expect(parseKbLocator('Plan.pdf (Projektwissen), p.3')).toEqual({
      filename: 'Plan.pdf',
      page: 3,
      scope: 'projekt',
    })
    expect(parseKbLocator('Plan.pdf (Büroarchiv)')).toEqual({
      filename: 'Plan.pdf',
      page: undefined,
      scope: 'buero',
    })
  })

  test('a parenthetical that is part of the filename is left alone', () => {
    // Only the KNOWN qualifiers are stripped; trimming any trailing "(…)" would
    // rename the document and lose the citation.
    expect(parseKbLocator('Bescheid (Kopie).pdf, p.2')).toEqual({
      filename: 'Bescheid (Kopie).pdf',
      page: 2,
      scope: undefined,
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
    { id: 'doc-2', filename: 'Vermessung.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { id: 'doc-3', filename: 'Lageplan.png', contentType: 'image/png' },
  ]
  const baseCorpusFiles = ['oib-rl_2_ausgabe_mai_2023.pdf']

  /** An org Archiv document — a different scope, the SAME preview route. */
  const archivDocument: StoredDocumentRef = {
    id: 'archiv-1',
    filename: 'Bueroe_Detail_Attika.pdf',
    contentType: 'application/pdf',
  }

  test('http(s) URLs always link out, with origin from the host', () => {
    expect(
      resolveCitationTarget({ url: 'https://example.com/article', content: '' })
    ).toEqual({ kind: 'url', url: 'https://example.com/article', origin: 'web' })
    expect(
      resolveCitationTarget({ url: 'https://www.ris.bka.gv.at/Norm', content: '' })
    ).toEqual({ kind: 'url', url: 'https://www.ris.bka.gv.at/Norm', origin: 'ris' })
  })

  test('KB locator matching a previewable project document opens it', () => {
    const target = resolveCitationTarget(
      { url: '', content: '[KB] Brandschutzkonzept.pdf, p.3' },
      storedDocuments,
      baseCorpusFiles
    )

    expect(target).toEqual({
      kind: 'document',
      origin: 'kb',
      title: 'Brandschutzkonzept.pdf',
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
    const target = resolveCitationTarget(
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
    const target = resolveCitationTarget(
      { url: '', content: '[KB] Brandschutzkonzept.pdf' },
      [...storedDocuments, shadowed],
      baseCorpusFiles
    )

    expect(target).toMatchObject({ document: { id: 'doc-1' } })
  })

  describe('a citation names its own shelf', () => {
    // Ordering ("project first") is a tie-break, not an identity. When the
    // citation knows which collection it came from, that wins — otherwise a
    // Büroarchiv citation opens the project's unrelated file of the same name.
    const scopedDocuments: StoredDocumentRef[] = [
      { id: 'doc-1', filename: 'Plan.pdf', contentType: 'application/pdf', scope: 'projekt' },
      { id: 'archiv-9', filename: 'Plan.pdf', contentType: 'application/pdf', scope: 'buero' },
    ]

    test('the wire collection resolves to the Archiv copy', () => {
      const target = resolveCitationTarget(
        { url: '', content: '[KB] Plan.pdf, p.2', collection: 'archiv_org1' },
        scopedDocuments
      )

      expect(target).toMatchObject({ document: { id: 'archiv-9' } })
    })

    test("a key's qualifier resolves it too, with no collection on the wire", () => {
      const target = resolveCitationTarget(
        { url: '', content: '[KB] Plan.pdf (Büroarchiv), p.2' },
        scopedDocuments
      )

      expect(target).toMatchObject({ title: 'Plan.pdf', document: { id: 'archiv-9' } })
    })

    test('the project copy is still reachable', () => {
      const target = resolveCitationTarget(
        { url: '', content: '[KB] Plan.pdf, p.2', collection: 'proj_alpha' },
        scopedDocuments
      )

      expect(target).toMatchObject({ document: { id: 'doc-1' } })
    })

    test('a shelf holding no such document falls back rather than failing', () => {
      // Fail-open, matching the backend: a scope that matches nothing must never
      // turn a document that opens today into a dead info popover.
      const target = resolveCitationTarget(
        { url: '', content: '[KB] Plan.pdf, p.2', collection: 'oib_knowledge' },
        scopedDocuments
      )

      expect(target).toMatchObject({ kind: 'document', document: { id: 'doc-1' } })
    })

    test('a Basiswissen citation opens the base corpus, not a same-named upload', () => {
      // The base corpus has no StoredDocumentRef row, so the base-corpus shelf
      // was the one scope that resolved to the wrong document whenever a project
      // upload shared the filename.
      const target = resolveCitationTarget(
        { url: '', content: '[KB] Plan.pdf (Basiswissen), p.2' },
        scopedDocuments,
        ['Plan.pdf']
      )

      expect(target).toMatchObject({ document: { type: 'base', fileName: 'Plan.pdf' } })
    })

    test('a Basiswissen citation with no base-corpus copy still falls back', () => {
      const target = resolveCitationTarget(
        { url: '', content: '[KB] Plan.pdf (Basiswissen), p.2' },
        scopedDocuments,
        ['oib-rl_2.pdf']
      )

      expect(target).toMatchObject({ document: { type: 'stored', id: 'doc-1' } })
    })

    test('untagged rows still resolve for callers that supply no scope', () => {
      const target = resolveCitationTarget(
        { url: '', content: '[KB] Brandschutzkonzept.pdf', collection: 'proj_alpha' },
        storedDocuments
      )

      expect(target).toMatchObject({ document: { id: 'doc-1' } })
    })
  })

  test('project filename matching is case-insensitive', () => {
    const target = resolveCitationTarget(
      { url: '', content: '[KB] brandschutzkonzept.PDF' },
      storedDocuments
    )

    expect(target.kind).toBe('document')
  })

  test('image project documents are previewable', () => {
    const target = resolveCitationTarget({ url: '', content: '[KB] Lageplan.png' }, storedDocuments)

    expect(target).toMatchObject({
      kind: 'document',
      document: { type: 'stored', id: 'doc-3', contentType: 'image/png' },
    })
  })

  test('non-previewable project documents degrade to info — never a broken viewer', () => {
    const target = resolveCitationTarget(
      { url: '', content: '[KB] Vermessung.docx' },
      storedDocuments,
      baseCorpusFiles
    )

    expect(target).toEqual({
      kind: 'info',
      origin: 'kb',
      title: 'Vermessung.docx',
      snippet: undefined,
    })
  })

  test('KB locator matching a base-corpus PDF opens the corpus viewer', () => {
    const target = resolveCitationTarget(
      { url: '', content: '[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.12' },
      storedDocuments,
      baseCorpusFiles
    )

    expect(target).toEqual({
      kind: 'document',
      origin: 'kb',
      title: 'oib-rl_2_ausgabe_mai_2023.pdf',
      page: 12,
      snippet: undefined,
      document: { type: 'base', fileName: 'oib-rl_2_ausgabe_mai_2023.pdf' },
    })
  })

  test('a pseudo-URL basename resolves when the content carries no locator', () => {
    const target = resolveCitationTarget(
      { url: 'kb://Brandschutzkonzept.pdf', content: '' },
      storedDocuments
    )

    expect(target).toMatchObject({ kind: 'document', document: { id: 'doc-1' } })
  })

  test('unresolvable citations become info with title and snippet', () => {
    const target = resolveCitationTarget(
      { url: '', content: '[KB] unbekannt.pdf, p.4\nZitierter Absatz.' },
      storedDocuments,
      baseCorpusFiles
    )

    expect(target).toEqual({
      kind: 'info',
      origin: 'kb',
      title: 'unbekannt.pdf',
      snippet: 'Zitierter Absatz.',
    })
  })

  test('without document lists everything degrades to info', () => {
    const target = resolveCitationTarget({ url: '', content: '[KB] Brandschutzkonzept.pdf' })

    expect(target.kind).toBe('info')
  })
})
