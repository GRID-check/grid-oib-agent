import { describe, expect, test } from 'vitest'
import {
  deriveTraceLanes,
  deriveTraceSourceCards,
  extractTraceLanesFromPayload,
  flattenTraceSourceCards,
  laneForHitClient,
  laneKeyToSignal,
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

describe('laneForHitClient', () => {
  test('classifies collections and OIB filenames', () => {
    expect(laneForHitClient({ collection: 'oib_knowledge' })).toEqual({
      key: 'baurecht_oib',
      label: 'OIB-Richtlinie',
    })
    expect(laneForHitClient({ collection: 'proj_x' })).toEqual({
      key: 'projekt',
      label: 'Projektwissen',
    })
    expect(laneForHitClient({ collection: 'archiv_y' })).toEqual({
      key: 'buero',
      label: 'Büroarchiv',
    })
    expect(laneForHitClient({ fileName: 'OIB-RL_2_Brandschutz.pdf' }).key).toBe('baurecht_oib')
    expect(laneForHitClient({ sourceUrl: 'https://ris.bka.gv.at/eli/bgbl/1' }).key).toBe(
      'baurecht_ris'
    )
    expect(laneForHitClient({ sourceUrl: 'https://example.com/a' }).key).toBe('web')
  })

  test('classifies the official OIB domain as Baurecht/OIB, not web', () => {
    expect(laneForHitClient({ sourceUrl: 'https://www.oib.or.at/de/oib-richtlinien' })).toEqual({
      key: 'baurecht_oib',
      label: 'OIB-Richtlinie',
    })
    expect(laneForHitClient({ sourceUrl: 'https://oib.or.at/anything' }).key).toBe('baurecht_oib')
  })

  test('classifies wien.gv.at as behördliche Information (Baurecht family), not web', () => {
    // The MA-37 (Baupolizei Wien) registry pointer must never read as a web
    // search hit; the behoerde lane maps to the law/baurecht signal.
    expect(laneForHitClient({ sourceUrl: 'https://www.wien.gv.at/wohnen/baupolizei' })).toEqual({
      key: 'behoerde',
      label: 'Behördliche Information',
    })
    expect(laneKeyToSignal(laneForHitClient({ sourceUrl: 'https://wien.gv.at/x' }).key)).toBe('law')
  })

  test('matches official domains on the host boundary, not as a substring', () => {
    // Lookalike hosts and URLs that merely mention a domain in the path/query
    // must not inherit an authoritative lane.
    expect(laneForHitClient({ sourceUrl: 'https://evil.example/wien.gv.at' }).key).toBe('web')
    expect(laneForHitClient({ sourceUrl: 'https://evil.example/?q=ris.bka.gv.at' }).key).toBe('web')
    expect(laneForHitClient({ sourceUrl: 'https://wien.gv.at.evil.example/x' }).key).toBe('web')
    expect(laneForHitClient({ sourceUrl: 'https://notoib.or.at/x' }).key).toBe('web')
    // Real hosts still match, case-insensitively and with subdomains.
    expect(laneForHitClient({ sourceUrl: 'https://WWW.WIEN.GV.AT/x' }).key).toBe('behoerde')
    expect(laneForHitClient({ sourceUrl: 'wien.gv.at/wohnen' }).key).toBe('behoerde')
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
      signal: 'law',
    })
    expect(cards![0].sources[0]).toEqual({
      name: 'OIB-RL_2_Brandschutz.pdf',
      detail: 'p.12',
    })
  })
})

describe('extractTraceLanesFromPayload', () => {
  test('prefers Trace-Lanes block over Result blocks', () => {
    const cards = extractTraceLanesFromPayload(kbPayload)
    expect(cards.map((c) => c.key)).toEqual(['baurecht_oib', 'projekt', 'buero'])
  })

  test('falls back to Result-block parsing without Trace-Lanes', () => {
    const without = kbPayload.replace(/## Trace-Lanes[\s\S]*$/, '')
    const cards = extractTraceLanesFromPayload(without)
    expect(cards).toHaveLength(3)
    expect(cards.find((c) => c.key === 'baurecht_oib')?.hitCount).toBe(1)
    expect(cards.find((c) => c.key === 'projekt')?.sources[0].name).toBe('Brandschutzkonzept.pdf')
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

describe('flattenTraceSourceCards / deriveTraceSourceCards', () => {
  test('flattens lane hits into per-document cards with Treffer counts', () => {
    const cards = flattenTraceSourceCards([
      {
        key: 'baurecht_oib',
        label: 'OIB-Richtlinie',
        hitCount: 3,
        sources: [
          { name: 'OIB-RL_2.pdf', detail: 'p.1' },
          { name: 'OIB-RL_2.pdf', detail: 'p.2' },
          { name: 'OIB-RL_4.pdf', detail: 'p.5' },
        ],
        signal: 'law',
      },
    ])
    expect(cards).toHaveLength(2)
    // Dedup keys on the raw filename (`fileName`); `name` is the display name.
    const oib2 = cards.find((c) => c.fileName === 'OIB-RL_2.pdf')
    expect(oib2).toMatchObject({
      tabLabel: 'OIB-Richtlinie',
      signal: 'law',
      authority: 'OIB',
      hitCount: 2,
      kind: 'hit',
    })
    expect(oib2?.detail).toContain('p.1')
  })

  test('cards carry the display name, never the raw corpus filename', () => {
    const [card] = flattenTraceSourceCards([
      {
        key: 'baurecht_oib',
        label: 'OIB-Richtlinie',
        hitCount: 1,
        sources: [{ name: 'oib-rl_2_ausgabe_mai_2023.pdf' }],
        signal: 'law',
      },
    ])
    expect(card?.name).toBe('OIB-Richtlinie 2')
    expect(card?.fileName).toBe('oib-rl_2_ausgabe_mai_2023.pdf')
  })

  test('an authoritative title from the wire wins over the client derivation', () => {
    const [card] = flattenTraceSourceCards([
      {
        key: 'baurecht_oib',
        label: 'OIB-Richtlinie',
        hitCount: 1,
        // Backend `## Trace-Lanes` now ships the stored (admin-editable)
        // display_title alongside the filename.
        sources: [{ name: 'oib-rl_2_ausgabe_mai_2023.pdf', title: 'Hausregel Brandschutz' }],
        signal: 'law',
      },
    ])
    expect(card?.name).toBe('Hausregel Brandschutz')
  })

  test('carries the same OIB/RIS authority badge as the Belegt-durch chips', () => {
    const [oib] = flattenTraceSourceCards([
      { key: 'baurecht_oib', label: 'OIB-Richtlinie', hitCount: 1, sources: [{ name: 'x.pdf' }], signal: 'law' },
    ])
    const [ris] = flattenTraceSourceCards([
      { key: 'baurecht_ris', label: 'Rechtsquelle (RIS)', hitCount: 1, sources: [{ name: 'BO Wien' }], signal: 'law' },
    ])
    const [buero] = flattenTraceSourceCards([
      { key: 'buero', label: 'Büroarchiv', hitCount: 1, sources: [{ name: 'detail.pdf' }], signal: 'office' },
    ])
    expect(oib?.authority).toBe('OIB')
    expect(ris?.authority).toBe('RIS')
    expect(buero?.authority).toBeUndefined()
  })

  test('deriveTraceSourceCards returns one card per document from live payload', () => {
    const cards = deriveTraceSourceCards([
      {
        functionName: 'knowledge_retrieval',
        category: 'tools',
        content: kbPayload,
      },
    ])
    // Names are the humanized display names; the raw filenames stay on
    // `fileName` for dedup and the tooltip.
    expect(cards.map((c) => c.name).sort()).toEqual([
      'Brandschutzkonzept',
      'Mustervorlage',
      'OIB-Richtlinie 2',
    ])
    expect(cards.map((c) => c.fileName).sort()).toEqual([
      'Brandschutzkonzept.pdf',
      'Mustervorlage.pdf',
      'OIB-RL_2_Brandschutz.pdf',
    ])
    expect(cards.find((c) => c.fileName === 'Mustervorlage.pdf')?.signal).toBe('office')
  })
})
