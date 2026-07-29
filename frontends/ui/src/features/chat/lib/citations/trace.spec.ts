/**
 * The Herleitung fan-out, as a projection of the citation model.
 *
 * Ported from `trace-lanes.spec.ts`, which used to pin a SECOND presentation
 * pipeline: the trace derived its own display names, tints and authority badges
 * from lane buckets, independently of the chips under the answer. These cases
 * assert the same user-visible facts, now produced by the one model both
 * surfaces read — so they can no longer be satisfied by two implementations
 * that agree today and drift tomorrow.
 */

import { describe, expect, test } from 'vitest'
import type { TraceLaneCard } from '../trace-lanes'
import { deriveTraceLanes } from '../trace-lanes'
import { buildCitationModel } from './build'
import { citedPages, isCited } from './model'
import { documentTabLabel, totalHits } from './views'

const lane = (overrides: Partial<TraceLaneCard>): TraceLaneCard => ({
  key: 'baurecht_oib',
  label: 'OIB-Richtlinie',
  kind: 'baurecht',
  signal: 'law',
  hitCount: 1,
  sources: [],
  ...overrides,
})

const kbPayload = `
Found 3 relevant document(s):

--- Result 1 ---
Source: Brandschutzkonzept.pdf
Collection: proj_1
Page: 4
Citation: Brandschutzkonzept.pdf, p.4
Content Type: text
Relevance Score: 0.91

Ein Absatz.

## Trace-Lanes
{"lanes":[{"key":"projekt","label":"Projektwissen","kind":"projekt","hitCount":2,"sources":[{"name":"Brandschutzkonzept.pdf","detail":"p.4"},{"name":"Mustervorlage.pdf","detail":"p.1"}]}]}
`

describe('the fan-out is the model, grouped by document', () => {
  test('several pages of one document are one card with a Treffer count', () => {
    const docs = buildCitationModel({
      traceLanes: [
        lane({
          hitCount: 3,
          sources: [
            { name: 'OIB-RL_2.pdf', detail: 'p.1' },
            { name: 'OIB-RL_2.pdf', detail: 'p.2' },
            { name: 'OIB-RL_4.pdf', detail: 'p.5' },
          ],
        }),
      ],
    })

    expect(docs).toHaveLength(2)
    const oib2 = docs.find((doc) => doc.fileName === 'OIB-RL_2.pdf')!
    expect(documentTabLabel(oib2)).toBe('OIB-Richtlinie')
    expect(oib2.tint).toBe('oib')
    expect(oib2.authority).toBe('OIB')
    expect(oib2.loci).toHaveLength(2)
    expect(citedPages(oib2)).toEqual([1, 2])
    expect(totalHits(docs)).toBe(3)
  })

  test('a card carries the display name, never the raw corpus filename', () => {
    const [doc] = buildCitationModel({
      traceLanes: [lane({ sources: [{ name: 'oib-rl_2_ausgabe_mai_2023.pdf' }] })],
    })
    expect(doc!.title).toBe('OIB-Richtlinie 2, Ausgabe Mai 2023')
    expect(doc!.fileName).toBe('oib-rl_2_ausgabe_mai_2023.pdf')
  })

  test('an authoritative title from the wire wins over the client derivation', () => {
    // The backend `## Trace-Lanes` ships the stored (admin-editable)
    // display_title alongside the filename.
    const [doc] = buildCitationModel({
      traceLanes: [
        lane({
          sources: [{ name: 'oib-rl_2_ausgabe_mai_2023.pdf', title: 'Hausregel Brandschutz' }],
        }),
      ],
    })
    expect(doc!.title).toBe('Hausregel Brandschutz')
  })

  test('carries the same OIB/RIS authority badge as the Belegt-durch chips', () => {
    const badgeFor = (card: TraceLaneCard): string | undefined =>
      buildCitationModel({ traceLanes: [card] })[0]?.authority

    expect(badgeFor(lane({ sources: [{ name: 'x.pdf' }] }))).toBe('OIB')
    expect(
      badgeFor(
        lane({ key: 'baurecht_ris', label: 'Rechtsquelle (RIS)', sources: [{ name: 'BO Wien' }] })
      )
    ).toBe('RIS')
    expect(
      badgeFor(
        lane({
          key: 'buero',
          label: 'Büroarchiv',
          kind: 'buero',
          signal: 'office',
          sources: [{ name: 'detail.pdf' }],
        })
      )
    ).toBeUndefined()
  })

  test('one card per document from a live tool payload', () => {
    const docs = buildCitationModel({
      traceLanes: deriveTraceLanes([
        { functionName: 'knowledge_retrieval', category: 'tools', content: kbPayload },
      ]),
    })
    expect(docs.map((doc) => doc.title).sort()).toEqual(['Brandschutzkonzept', 'Mustervorlage'])
    // Retrieved is not cited: nothing here claims the answer used these.
    expect(docs.every((doc) => !isCited(doc))).toBe(true)
  })

  test('a web lane keeps its hostname as the name and links out', () => {
    const [doc] = buildCitationModel({
      traceLanes: [
        lane({
          key: 'web',
          label: 'Web',
          kind: 'web',
          signal: 'auto',
          sources: [
            { name: 'example.org', title: 'example.org', detail: 'https://example.org/doc' },
          ],
        }),
      ],
    })
    expect(doc!.title).toBe('example.org')
    expect(doc!.url).toBe('https://example.org/doc')
    expect(doc!.tint).toBe('auto')
  })
})

describe('robustness at the edges', () => {
  test('a source identified by nothing at all never becomes a card', () => {
    // A citation with no filename, no URL and no label cannot be cited,
    // previewed or copied. It used to render as a nameless card reading
    // "label:" on the surface whose job is to say where an answer came from.
    const docs = buildCitationModel({
      citations: [
        {
          id: 'ghost',
          content: '',
          timestamp: new Date(0),
          kind: 'baurecht',
          lane: 'baurecht_oib',
          laneLabel: 'OIB-Richtlinie',
        },
      ],
    })
    expect(docs).toEqual([])
  })

  test('a label-only trace hit and the cited source it names are ONE document', () => {
    // The RIS case: `## Trace-Lanes` knows the norm only by its name, while the
    // answer's citation of it arrives with a real RIS URL. Two identities, one
    // document — it used to render twice, once cited and once "read, not used".
    const docs = buildCitationModel({
      traceLanes: [
        lane({
          key: 'baurecht_ris',
          label: 'Bundesrecht',
          sources: [{ name: 'Bauordnung für Wien', detail: '§ 108 Fluchtwege' }],
        }),
      ],
      citations: [
        {
          id: 'ris',
          content: '[RIS] Bauordnung für Wien § 108',
          url: 'https://www.ris.bka.gv.at/x',
          title: 'Bauordnung für Wien',
          timestamp: new Date(0),
          kind: 'baurecht',
          lane: 'baurecht_ris',
          number: 2,
          isCited: true,
        },
      ],
    })

    expect(docs).toHaveLength(1)
    expect(docs[0]!.title).toBe('Bauordnung für Wien')
    expect(isCited(docs[0]!)).toBe(true)
    expect(docs[0]!.url).toBe('https://www.ris.bka.gv.at/x')
  })
})
