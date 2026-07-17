import { describe, test, expect } from 'vitest'
import {
  citationSnippet,
  deriveAnswerSources,
  parseKbLocator,
  resolveCitationTarget,
  type ProjectDocumentRef,
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
  const projectDocuments: ProjectDocumentRef[] = [
    { id: 'doc-1', filename: 'Brandschutzkonzept.pdf', contentType: 'application/pdf' },
    { id: 'doc-2', filename: 'Vermessung.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { id: 'doc-3', filename: 'Lageplan.png', contentType: 'image/png' },
  ]
  const baseCorpusFiles = ['oib-rl_2_ausgabe_mai_2023.pdf']

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
      projectDocuments,
      baseCorpusFiles
    )

    expect(target).toEqual({
      kind: 'document',
      origin: 'kb',
      title: 'Brandschutzkonzept.pdf',
      page: 3,
      snippet: undefined,
      document: {
        type: 'project',
        id: 'doc-1',
        filename: 'Brandschutzkonzept.pdf',
        contentType: 'application/pdf',
      },
    })
  })

  test('project filename matching is case-insensitive', () => {
    const target = resolveCitationTarget(
      { url: '', content: '[KB] brandschutzkonzept.PDF' },
      projectDocuments
    )

    expect(target.kind).toBe('document')
  })

  test('image project documents are previewable', () => {
    const target = resolveCitationTarget({ url: '', content: '[KB] Lageplan.png' }, projectDocuments)

    expect(target).toMatchObject({
      kind: 'document',
      document: { type: 'project', id: 'doc-3', contentType: 'image/png' },
    })
  })

  test('non-previewable project documents degrade to info — never a broken viewer', () => {
    const target = resolveCitationTarget(
      { url: '', content: '[KB] Vermessung.docx' },
      projectDocuments,
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
      projectDocuments,
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
      projectDocuments
    )

    expect(target).toMatchObject({ kind: 'document', document: { id: 'doc-1' } })
  })

  test('unresolvable citations become info with title and snippet', () => {
    const target = resolveCitationTarget(
      { url: '', content: '[KB] unbekannt.pdf, p.4\nZitierter Absatz.' },
      projectDocuments,
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
