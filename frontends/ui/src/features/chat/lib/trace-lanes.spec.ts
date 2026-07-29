import { describe, expect, test } from 'vitest'
import {
  deriveTraceLanes,
  extractTraceLanesFromPayload,
  laneForSourceUrl,
  laneKeyToSignal,
  mergeTraceLaneCards,
  parseTraceLanesBlock,
  totalTraceSourceCount,
} from './trace-lanes'

const kbPayload = `
Found 3 relevant document(s):

--- Result 1 ---
Source: OIB-RL_2_Brandschutz.pdf
Collection: oib_knowledge
Page: 12
Citation: OIB-RL_2_Brandschutz.pdf, p.12
Content Type: text
Relevance Score: 0.91

Some brandschutz content

--- Result 2 ---
Source: Brandschutzkonzept.pdf
Collection: proj_abc-123
Page: 3
Citation: Brandschutzkonzept.pdf, p.3
Content Type: text
Relevance Score: 0.80

Project content

--- Result 3 ---
Source: Mustervorlage.pdf
Collection: archiv_org1
Citation: Mustervorlage.pdf
Content Type: text
Relevance Score: 0.70

Archiv content

## Trace-Lanes
{"lanes":[{"key":"baurecht_oib","label":"OIB-Richtlinie","hitCount":1,"sources":[{"name":"OIB-RL_2_Brandschutz.pdf","detail":"p.12"}]},{"key":"projekt","label":"Projektwissen","hitCount":1,"sources":[{"name":"Brandschutzkonzept.pdf","detail":"p.3"}]},{"key":"buero","label":"Büroarchiv","hitCount":1,"sources":[{"name":"Mustervorlage.pdf"}]}]}
`

describe('laneKeyToSignal', () => {
  test('maps strata onto provenance signals', () => {
    expect(laneKeyToSignal('baurecht_oib')).toBe('law')
    expect(laneKeyToSignal('baurecht_bund')).toBe('law')
    expect(laneKeyToSignal('projekt')).toBe('project')
    expect(laneKeyToSignal('buero')).toBe('office')
    expect(laneKeyToSignal('web')).toBe('auto')
  })

  test('agrees with the chips on external norms and authority info (was diverging to web)', () => {
    // norm_extern / behoerde are Baurecht (law) — the Herleitung previously
    // rendered them in the web/auto family, disagreeing with the chips (ADR-0026).
    expect(laneKeyToSignal('norm_extern')).toBe('law')
    expect(laneKeyToSignal('behoerde')).toBe('law')
  })
})

describe('laneForSourceUrl', () => {
  test('classifies the sources that carry no structured lane', () => {
    expect(laneForSourceUrl('https://ris.bka.gv.at/eli/bgbl/1').key).toBe('baurecht_ris')
    expect(laneForSourceUrl('https://example.com/a').key).toBe('web')
    expect(laneForSourceUrl(null).key).toBe('web')
  })

  test('classifies the official OIB domain as Baurecht/OIB, not web', () => {
    expect(laneForSourceUrl('https://www.oib.or.at/de/oib-richtlinien')).toEqual({
      key: 'baurecht_oib',
      label: 'OIB-Richtlinie',
    })
    expect(laneForSourceUrl('https://oib.or.at/anything').key).toBe('baurecht_oib')
  })

  test('classifies wien.gv.at as behördliche Information (Baurecht family), not web', () => {
    // The MA-37 (Baupolizei Wien) registry pointer must never read as a web
    // search hit; the behoerde lane maps to the law/baurecht signal.
    expect(laneForSourceUrl('https://www.wien.gv.at/wohnen/baupolizei')).toEqual({
      key: 'behoerde',
      label: 'Behördliche Information',
    })
    expect(laneKeyToSignal(laneForSourceUrl('https://wien.gv.at/x').key)).toBe('law')
  })

  test('matches official domains on the host boundary, not as a substring', () => {
    // Lookalike hosts and URLs that merely mention a domain in the path/query
    // must not inherit an authoritative lane.
    expect(laneForSourceUrl('https://evil.example/wien.gv.at').key).toBe('web')
    expect(laneForSourceUrl('https://evil.example/?q=ris.bka.gv.at').key).toBe('web')
    expect(laneForSourceUrl('https://wien.gv.at.evil.example/x').key).toBe('web')
    expect(laneForSourceUrl('https://notoib.or.at/x').key).toBe('web')
    // Real hosts still match, case-insensitively and with subdomains.
    expect(laneForSourceUrl('https://WWW.WIEN.GV.AT/x').key).toBe('behoerde')
    expect(laneForSourceUrl('wien.gv.at/wohnen').key).toBe('behoerde')
  })
})

describe('parseTraceLanesBlock', () => {
  test('parses backend JSON block', () => {
    const cards = parseTraceLanesBlock(kbPayload)
    expect(cards).toHaveLength(3)
    expect(cards![0]).toMatchObject({
      key: 'baurecht_oib',
      label: 'OIB-Richtlinie',
      hitCount: 1,
      kind: 'baurecht',
      signal: 'law',
    })
    expect(cards![0].sources[0]).toEqual({
      name: 'OIB-RL_2_Brandschutz.pdf',
      detail: 'p.12',
    })
  })

  test('takes the coarse kind from the backend rather than re-deriving it', () => {
    // The wire's `kind` is authoritative even when it disagrees with what this
    // side would have guessed from the lane key — that is the point of shipping
    // it: one classifier, on the producing side, for the chips and the fan-out.
    const [lane] = parseTraceLanesBlock(
      '## Trace-Lanes\n{"lanes":[{"key":"kein_lane_key_den_wir_kennen","label":"Neu","kind":"buero","hitCount":1,"sources":[{"name":"a.pdf"}]}]}\n'
    )!
    expect(lane.kind).toBe('buero')
    expect(lane.signal).toBe('office')
  })

  test('a payload persisted before the block carried `kind` still classifies', () => {
    // Back-compat only: `kindForLane` is the shared lane→kind table, applied
    // here as a decode fallback for lanes emitted before the field existed.
    const [lane] = parseTraceLanesBlock(
      '## Trace-Lanes\n{"lanes":[{"key":"baurecht_ris","label":"Rechtsquelle (RIS)","hitCount":1,"sources":[{"name":"BO Wien"}]}]}\n'
    )!
    expect(lane.kind).toBe('baurecht')
    expect(lane.signal).toBe('law')
  })
})

describe('extractTraceLanesFromPayload', () => {
  test('reads the Trace-Lanes block for knowledge-layer output', () => {
    const cards = extractTraceLanesFromPayload(kbPayload)
    expect(cards.map((c) => c.key)).toEqual(['baurecht_oib', 'projekt', 'buero'])
  })

  test('yields nothing for KB output whose Trace-Lanes block is missing or empty', () => {
    // `_format_results` writes the block into the same string as the Result
    // blocks, so a KB payload without lanes means the backend said "no lanes".
    // Re-deriving them here (from less information than the producer had) is
    // exactly the mirror that let the fan-out and the chips drift apart.
    const withoutBlock = kbPayload.replace(/## Trace-Lanes[\s\S]*$/, '')
    expect(extractTraceLanesFromPayload(withoutBlock)).toEqual([])
    expect(extractTraceLanesFromPayload(`${withoutBlock}\n## Trace-Lanes\n{"lanes":[]}\n`)).toEqual(
      []
    )
  })

  test('never URL-scans a retrieved passage that happens to contain a link', () => {
    // Chunk bodies are corpus prose; a link inside one is not a source the tool
    // returned. Before the KB-marker guard this fell through to the URL scan.
    const withLinkInBody = kbPayload
      .replace(/## Trace-Lanes[\s\S]*$/, '')
      .replace('Some brandschutz content', 'Siehe https://www.example.com/anhang')
    expect(extractTraceLanesFromPayload(withLinkInBody)).toEqual([])
  })

  test('falls back to URL scan for web results', () => {
    const web = `
Results:
1. https://ris.bka.gv.at/Dokumente/Bundesnormen/foo
2. https://www.example.com/guide
3. https://www.example.com/guide
`
    const cards = extractTraceLanesFromPayload(web)
    expect(cards).toHaveLength(2)
    expect(cards.find((c) => c.key === 'baurecht_ris')?.hitCount).toBe(1)
    expect(cards.find((c) => c.key === 'web')?.hitCount).toBe(1)
  })
})

describe('mergeTraceLaneCards', () => {
  const oib = (sources: Array<{ name: string; title?: string; detail?: string }>, hitCount = 1) => ({
    key: 'baurecht_oib',
    label: 'OIB-Richtlinie',
    hitCount,
    sources,
    kind: 'baurecht' as const,
    signal: 'law' as const,
  })

  test('unions the hits of two reports of the same step', () => {
    const merged = mergeTraceLaneCards(
      [oib([{ name: 'a.pdf', detail: 'p.12' }])],
      [oib([{ name: 'b.pdf', detail: 'p.3' }])]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].sources.map((s) => s.name)).toEqual(['a.pdf', 'b.pdf'])
    expect(merged[0].hitCount).toBe(2)
  })

  test('counts a re-reported hit once, but keeps two pages of one document apart', () => {
    // The second call of a tool routinely returns the same passage again; that
    // is one hit told twice, not new evidence. Two pages of the same file are
    // two hits and must survive as two.
    const same = mergeTraceLaneCards(
      [oib([{ name: 'a.pdf', detail: 'p.12' }])],
      [oib([{ name: ' A.PDF ', detail: 'P.12' }])]
    )
    expect(same[0].sources).toHaveLength(1)
    expect(same[0].hitCount).toBe(1)

    const pages = mergeTraceLaneCards(
      [oib([{ name: 'a.pdf', detail: 'p.12' }])],
      [oib([{ name: 'a.pdf', detail: 'p.31' }])]
    )
    expect(pages[0].sources).toHaveLength(2)
    expect(pages[0].hitCount).toBe(2)
  })

  test('takes a backend title a later report adds to a hit already known', () => {
    const merged = mergeTraceLaneCards(
      [oib([{ name: 'a.pdf', detail: 'p.12' }])],
      [oib([{ name: 'a.pdf', title: 'OIB-Richtlinie 2', detail: 'p.12' }])]
    )
    expect(merged[0].sources[0].title).toBe('OIB-Richtlinie 2')
  })

  test('never lowers a hitCount a producer claimed without listing sources', () => {
    expect(mergeTraceLaneCards([oib([], 3)], [oib([], 2)])[0].hitCount).toBe(3)
  })

  test('is a no-op on either side being empty', () => {
    expect(mergeTraceLaneCards(undefined, null)).toEqual([])
    expect(mergeTraceLaneCards([oib([{ name: 'a.pdf' }])], null)).toEqual([
      oib([{ name: 'a.pdf' }]),
    ])
  })
})

describe('deriveTraceLanes', () => {
  test('aggregates across steps and prefers stored traceLanes', () => {
    const fromStored = deriveTraceLanes([
      {
        functionName: 'knowledge_retrieval',
        category: 'tools',
        content: '',
        traceLanes: [
          {
            key: 'baurecht_oib',
            label: 'OIB-Richtlinie',
            hitCount: 2,
            sources: [{ name: 'a.pdf' }],
            signal: 'law',
          },
        ],
      },
    ])
    expect(fromStored).toHaveLength(1)
    expect(fromStored[0].hitCount).toBe(2)

    const live = deriveTraceLanes([
      {
        functionName: 'knowledge_retrieval',
        category: 'tools',
        content: kbPayload,
      },
      {
        functionName: 'web_search_tool',
        category: 'tools',
        content: 'See https://example.org/doc',
      },
    ])
    expect(totalTraceSourceCount(live)).toBe(4) // 3 KB + 1 web
    expect(live[0].signal).toBe('law')
  })

  test('skips non-tool agent chatter without tool markers', () => {
    const cards = deriveTraceLanes([
      {
        functionName: 'intent_classifier',
        category: 'agents',
        content: 'Classifying intent for https://example.com/x',
      },
    ])
    expect(cards).toHaveLength(0)
  })

  test('does not fabricate a source from a URL echoed in shallow_research prose', () => {
    // "reSEARCH" matches the /search/ tool heuristic, so shallow_research prose
    // used to be URL-scanned — an example link like oib.or.at (handed to the
    // model by its own prompt) then rendered as a phantom "Web" source card
    // even though the timeline shows zero tool calls. It must yield nothing.
    const cards = deriveTraceLanes([
      {
        functionName: 'shallow_research',
        category: 'agents',
        content:
          'Grid speichert Daten in einer Wissensdatenbank. Siehe https://www.oib.or.at/de/oib-richtlinien',
      },
    ])
    expect(cards).toHaveLength(0)
  })

  test('still honors a structured Trace-Lanes block re-emitted by an agent step', () => {
    // The URL-scan gate must not suppress explicit backend markers.
    const cards = deriveTraceLanes([
      {
        functionName: 'shallow_research',
        category: 'agents',
        content: kbPayload,
      },
    ])
    expect(cards.map((c) => c.key)).toContain('baurecht_oib')
  })
})
