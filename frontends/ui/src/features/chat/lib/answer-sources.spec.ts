import { describe, test, expect } from 'vitest'
import { deriveAnswerSources } from './answer-sources'
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
})
