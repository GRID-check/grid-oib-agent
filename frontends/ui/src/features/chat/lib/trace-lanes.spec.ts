import { describe, expect, it } from 'vitest'
import { fixtureSteps, storedStep } from '@/test-utils/wire-v2-steps'
import { deriveTraceLanes } from './trace-lanes'

const sources = (id: string, lanes: Record<string, unknown>[], round?: number) =>
  storedStep({
    id,
    kind: 'sources',
    tool: 'knowledge_search',
    lanes,
    ...(round !== undefined ? { round } : {}),
  })

const oib = (hits: Record<string, unknown>[]) => ({
  key: 'baurecht_oib',
  label: 'OIB-Richtlinie',
  kind: 'baurecht',
  hit_count: hits.length,
  sources: hits,
})

describe('deriveTraceLanes', () => {
  it('reads the lanes of a recorded turn from its sources step', () => {
    const lanes = deriveTraceLanes(fixtureSteps('turn-answered.jsonl'))
    expect(lanes.length).toBeGreaterThan(0)
    expect(lanes[0]).toMatchObject({ key: 'baurecht_oib', signal: 'law' })
  })

  it('reads only sources steps', () => {
    const status = storedStep({
      id: 'status:synthesis',
      kind: 'status',
      slot: 'synthesis',
      key: 'status.synthesis',
    })
    const tool = storedStep({ id: 'tool:1', kind: 'tool', tool: 'web_search_tool', status: 'ok' })
    expect(deriveTraceLanes([status, tool])).toEqual([])
  })

  it('adds up the hits two tool calls returned in one lane', () => {
    const lanes = deriveTraceLanes([
      sources('sources:0', [oib([{ name: 'oib-rl_2.pdf', detail: 'p.12' }])], 0),
      sources('sources:1', [oib([{ name: 'oib-rl_2.pdf', detail: 'p.31' }])], 1),
    ])
    expect(lanes).toHaveLength(1)
    expect(lanes[0].hitCount).toBe(2)
    expect(lanes[0].sources.map((s) => s.detail)).toEqual(['p.12', 'p.31'])
  })

  it('does not mutate the stored lanes it aggregates', () => {
    const first = sources('sources:0', [oib([{ name: 'a.pdf' }])])
    deriveTraceLanes([first, sources('sources:1', [oib([{ name: 'b.pdf' }])])])
    expect(first.traceLanes?.[0].sources).toHaveLength(1)
    expect(first.traceLanes?.[0].hitCount).toBe(1)
  })

  it('orders law before project before office, then by label', () => {
    const lanes = deriveTraceLanes([
      sources('s', [
        {
          key: 'buero',
          label: 'Büroablage',
          kind: 'buero',
          hit_count: 1,
          sources: [{ name: 'x.pdf' }],
        },
        {
          key: 'projekt',
          label: 'Projektwissen',
          kind: 'projekt',
          hit_count: 1,
          sources: [{ name: 'y.pdf' }],
        },
        oib([{ name: 'z.pdf' }]),
      ]),
    ])
    expect(lanes.map((lane) => lane.signal)).toEqual(['law', 'project', 'office'])
  })
})
