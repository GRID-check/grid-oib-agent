import { describe, test, expect } from 'vitest'
import {
  answerSourceAnchorPrefix,
  answerSourceItems,
  mergeAnswerSources,
  splitAnswerBody,
} from './answer-source-list'
import type { ReportSourceEntry } from '@/features/layout/lib/report-citations'
import type { CitationSource } from '../types'
import type { GridCard } from '@/shared/cards/schemas'

const citation = (overrides: Partial<CitationSource>): CitationSource => ({
  id: overrides.id ?? 'c1',
  content: '',
  timestamp: new Date('2024-01-15T14:30:00'),
  isCited: true,
  ...overrides,
})

const entry = (number: number, markdown: string, sourceKind?: 'kb' | 'ris' | 'web'): ReportSourceEntry => ({
  number,
  markdown,
  sourceKind,
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

describe('mergeAnswerSources', () => {
  test("matches on the backend's citation number and keeps the chip's preview target", () => {
    const refs = [
      {
        key: 'citation-c1',
        label: 'ris.bka.gv.at',
        kind: 'ris' as const,
        signal: 'law' as const,
        authority: 'RIS',
        url: 'https://www.ris.bka.gv.at/x',
        number: 1,
        citation: citation({ id: 'c1', url: 'https://www.ris.bka.gv.at/x', number: 1 }),
      },
    ]

    const [item] = mergeAnswerSources(
      [entry(1, 'Wiener Garagengesetz 2008 — https://www.ris.bka.gv.at/x', 'ris')],
      refs
    )

    expect(item.number).toBe(1)
    // The written entry's real title wins over the chip's bare hostname …
    expect(item.ref.label).toBe('Wiener Garagengesetz 2008')
    // … while the chip keeps its authority badge, tint and citation (preview).
    expect(item.ref.authority).toBe('RIS')
    expect(item.ref.citation?.id).toBe('c1')
    expect(item.host).toBe('ris.bka.gv.at')
  })

  test('falls back to document identity when the wire carries no number', () => {
    const refs = [
      {
        key: 'citation-c2',
        label: 'OIB-Richtlinie 4, Ausgabe Mai 2023',
        kind: 'kb' as const,
        signal: 'oib' as const,
        authority: 'OIB',
        citation: citation({ id: 'c2', fileName: 'oib-rl_4_ausgabe_mai_2023.pdf', page: 9 }),
      },
    ]

    const [item] = mergeAnswerSources([entry(2, 'oib-rl_4_ausgabe_mai_2023.pdf, p.9', 'kb')], refs)

    expect(item.number).toBe(2)
    // The chip's human title beats the written entry's raw filename.
    expect(item.ref.label).toBe('OIB-Richtlinie 4, Ausgabe Mai 2023')
    expect(item.page).toBe(9)
    expect(item.ref.citation?.id).toBe('c2')
  })

  test('a written entry with no structured source still renders and stays openable', () => {
    const [item] = mergeAnswerSources([entry(1, 'brandschutzkonzept.pdf, p.4', 'kb')], [])

    expect(item.number).toBe(1)
    expect(item.ref.label).toBe('brandschutzkonzept.pdf')
    expect(item.page).toBe(4)
    // Carries a locator, so the chip resolves the same preview a citation would.
    expect(item.ref.citation?.fileName).toBe('brandschutzkonzept.pdf')
  })

  test('a structured source the prose never numbered is kept, after the numbered ones', () => {
    const refs = [
      {
        key: 'legal-OIB 2',
        label: 'OIB 2',
        kind: 'ris' as const,
        signal: 'oib' as const,
        authority: 'OIB',
      },
    ]

    const items = mergeAnswerSources([entry(1, 'plan.pdf, p.1', 'kb')], refs)

    expect(items.map((item) => item.number)).toEqual([1, undefined])
    expect(items[1].ref.label).toBe('OIB 2')
  })

  test('never drops a numbered source to the row cap', () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry(i + 1, `doc${i + 1}.pdf, p.1`, 'kb'))

    const items = mergeAnswerSources(entries, [])

    expect(items).toHaveLength(12)
    expect(items.map((item) => item.number)).toEqual(entries.map((e) => e.number))
  })

  test('deduplicates: the same source is one row, not one per stream', () => {
    const refs = [
      {
        key: 'citation-c3',
        label: 'OIB-Richtlinie 4, Ausgabe Mai 2023',
        kind: 'kb' as const,
        signal: 'oib' as const,
        citation: citation({ id: 'c3', fileName: 'oib-rl_4_ausgabe_mai_2023.pdf', page: 9 }),
      },
    ]

    const items = mergeAnswerSources([entry(1, 'OIB-Richtlinie 4, Ausgabe Mai 2023, p.9', 'kb')], refs)

    expect(items).toHaveLength(1)
  })
})

describe('answerSourceItems', () => {
  test('without a written section it is exactly the chip row (unchanged behavior)', () => {
    const items = answerSourceItems(
      undefined,
      [citation({ id: 'c1', url: 'https://example.com/a', title: 'A', isCited: true })],
      undefined
    )

    expect(items).toHaveLength(1)
    expect(items[0].number).toBeUndefined()
    expect(items[0].host).toBe('example.com')
  })

  test('merges legal_basis cards into the same numbered list', () => {
    const cards = [
      {
        type: 'legal_basis',
        law: 'OIB-Richtlinie 4',
        section: 'Pkt. 2.1',
        summary: 'Stellplatzgröße',
      },
    ] as unknown as GridCard[]

    const items = answerSourceItems([entry(1, 'oib-rl_4_ausgabe_mai_2023.pdf, p.9', 'kb')], undefined, cards)

    // The card names the same Richtlinie as the written entry → one row.
    expect(items).toHaveLength(1)
    expect(items[0].number).toBe(1)
  })

  test('returns nothing when the answer carries no provenance at all', () => {
    expect(answerSourceItems(undefined, undefined, undefined)).toEqual([])
  })
})
