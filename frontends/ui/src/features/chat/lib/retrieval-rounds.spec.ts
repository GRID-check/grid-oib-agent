/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test, expect } from 'vitest'
import {
  documentsForRound,
  retrievalRounds,
  unassignedDocuments,
  type RoundStep,
} from './retrieval-rounds'
import type { ThinkingStep } from '../types'
import type { CitedDocument } from './citations/model'

const step = (overrides: Partial<ThinkingStep> = {}): ThinkingStep => ({
  id: 's',
  userMessageId: 'm',
  category: 'agents',
  functionName: 'unknown',
  displayName: 'Unknown',
  content: '',
  isComplete: true,
  timestamp: new Date('2024-01-01T00:00:00Z'),
  ...overrides,
})

const retrieval = (index: number, query: string) =>
  step({
    id: `r${index}`,
    functionName: `status:retrieval:${index}`,
    displayName: `status:retrieval:${index}`,
    content: JSON.stringify({
      kind: 'status',
      channel: 'live',
      slot: `retrieval:${index}`,
      key: 'status.retrieval.withQuery',
      values: { corpus: 'knowledge', query },
    }),
  })

describe('retrievalRounds', () => {
  test('no steps → no rounds', () => {
    expect(retrievalRounds([])).toEqual([])
  })

  test('a single retrieval is one round', () => {
    expect(retrievalRounds([retrieval(0, 'Fluchtweg GK4')])).toEqual([
      {
        index: 0,
        key: 'status.retrieval.withQuery',
        values: { corpus: 'knowledge', query: 'Fluchtweg GK4' },
        tools: [],
        sourceNames: [],
      },
    ])
  })

  test('two retrieval slots are two rounds in index order', () => {
    const rounds = retrievalRounds([
      retrieval(1, 'Überhang Dachrand'),
      retrieval(0, 'OIB 3 Pkt. 3.4.2'),
    ])
    expect(rounds.map((r) => r.index)).toEqual([0, 1])
    expect(rounds[1]?.values?.query).toBe('Überhang Dachrand')
  })

  test('requery is not a round', () => {
    const requery = step({
      id: 'rq',
      functionName: 'status:retrieval:requery',
      content: JSON.stringify({
        kind: 'status',
        channel: 'live',
        slot: 'retrieval:requery',
        key: 'status.retrieval.requery',
        values: {},
      }),
    })
    expect(retrievalRounds([retrieval(0, 'GK4'), requery])).toHaveLength(1)
  })

  test('a persisted turnEvent still counts after prune', () => {
    const pruned = step({
      id: 'p',
      functionName: 'status:retrieval:0',
      content: '',
      rawPayload: '',
      turnEvent: {
        key: 'status.retrieval.withQuery',
        values: { corpus: 'knowledge', query: 'Geländerhöhe' },
      },
    })
    expect(retrievalRounds([pruned])).toEqual([
      {
        index: 0,
        key: 'status.retrieval.withQuery',
        values: { corpus: 'knowledge', query: 'Geländerhöhe' },
        tools: [],
        sourceNames: [],
      },
    ])
  })

  test('a checkpoint sentence survives prune as reason, not as the query', () => {
    const pruned = step({
      id: 'p',
      functionName: 'status:retrieval:1',
      content: '',
      rawPayload: '',
      turnEvent: {
        key: 'status.retrieval.withQuery',
        values: { corpus: 'knowledge', query: 'Überhang Dachrand' },
        reason: 'OIB 3 Pkt. 3.4.2 verweist auf den lichten Einfallswinkel.',
      },
    })
    expect(retrievalRounds([pruned])).toEqual([
      {
        index: 1,
        key: 'status.retrieval.withQuery',
        values: { corpus: 'knowledge', query: 'Überhang Dachrand' },
        reason: 'OIB 3 Pkt. 3.4.2 verweist auf den lichten Einfallswinkel.',
        tools: [],
        sourceNames: [],
      },
    ])
  })

  test('tool results after a retrieval belong to that fetch, not the next', () => {
    const hit = (id: string, file: string, round?: number): ThinkingStep =>
      step({
        id,
        functionName: 'knowledge_search',
        category: 'tools',
        traceLanes: [
          {
            key: 'baurecht_oib',
            label: 'OIB-Richtlinie',
            hitCount: 1,
            sources: [{ name: file, round }],
            signal: 'law',
          },
        ],
      })
    const rounds = retrievalRounds([
      retrieval(0, 'OIB 2'),
      hit('t0', 'oib-rl_2.pdf'),
      retrieval(1, 'Grundriss'),
      hit('t1', 'EG_Grundriss.pdf'),
    ])
    expect(rounds[0]?.sourceNames).toEqual(['oib-rl_2.pdf'])
    expect(rounds[1]?.sourceNames).toEqual(['EG_Grundriss.pdf'])
  })

  test('a merged knowledge_search step still splits files by stamped round', () => {
    // Production keys completions by functionName. Two fetches become one
    // step whose lanes are the union; stream order would dump both onto
    // round 0 (or both onto the last fetch). The round stamp is the join.
    const merged = step({
      id: 'merged',
      functionName: 'knowledge_search',
      category: 'tools',
      traceLanes: [
        {
          key: 'baurecht_oib',
          label: 'OIB-Richtlinie',
          hitCount: 1,
          sources: [{ name: 'oib-rl_2.pdf', round: 0 }],
          signal: 'law',
        },
        {
          key: 'projekt',
          label: 'Projektwissen',
          hitCount: 1,
          sources: [{ name: 'EG_Grundriss.pdf', round: 1 }],
          signal: 'project',
        },
      ],
    })
    const rounds = retrievalRounds([retrieval(0, 'OIB 2'), retrieval(1, 'Grundriss'), merged])
    expect(rounds[0]?.sourceNames).toEqual(['oib-rl_2.pdf'])
    expect(rounds[1]?.sourceNames).toEqual(['EG_Grundriss.pdf'])
  })

  test('tools on the retrieval event survive prune', () => {
    const pruned = step({
      id: 'p',
      functionName: 'status:retrieval:0',
      content: '',
      turnEvent: {
        key: 'status.retrieval.plain',
        values: { corpus: 'ifc' },
        tools: ['ifc_measure', 'knowledge_search'],
      },
    })
    expect(retrievalRounds([pruned])[0]?.tools).toEqual(['ifc_measure', 'knowledge_search'])
  })
})

describe('documentsForRound', () => {
  const doc = (id: string, fileName: string): CitedDocument => ({
    id,
    title: id,
    fileName,
    kind: 'baurecht',
    tint: 'law',
    loci: [{ key: 'whole', isCited: true }],
  })

  test('a file belongs to the fetch that returned it', () => {
    const oib = doc('oib', 'oib-rl_2.pdf')
    const plan = doc('plan', 'EG_Grundriss.pdf')
    const round0: ReturnType<typeof retrievalRounds>[number] = {
      index: 0,
      key: 'status.retrieval.withQuery',
      tools: ['knowledge_search'],
      sourceNames: ['oib-rl_2.pdf'],
    }
    const round1: ReturnType<typeof retrievalRounds>[number] = {
      index: 1,
      key: 'status.retrieval.withQuery',
      tools: ['knowledge_search'],
      sourceNames: ['EG_Grundriss.pdf'],
    }
    expect(documentsForRound(round0, [oib, plan]).map((c) => c.id)).toEqual(['oib'])
    expect(documentsForRound(round1, [oib, plan]).map((c) => c.id)).toEqual(['plan'])
    expect(unassignedDocuments([round0, round1], [oib, plan])).toEqual([])
  })

  test('a citation with no retrieval step is unassigned, not dropped', () => {
    const extra = doc('extra', 'Notiz.pdf')
    const round: ReturnType<typeof retrievalRounds>[number] = {
      index: 0,
      key: 'status.retrieval.plain',
      tools: [],
      sourceNames: ['oib-rl_2.pdf'],
    }
    expect(unassignedDocuments([round], [extra]).map((c) => c.id)).toEqual(['extra'])
  })
})

/**
 * The wire itself, not a copy of it.
 *
 * Every spec above builds its steps by hand, which proves the walker parses
 * what THIS FILE believes the backend sends. `tests/fixtures/herleitung/two_search_rounds_steps.json`
 * is written by the emitters (`tests/aiq_agent/agents/piloti/test_retrieval_rounds_spine.py`,
 * `TestTheSharedFixtureIsCurrent`), and that contract test names this spec as
 * its consumer: the Python side asserts the file is what the emitters produce,
 * this side asserts the walker reads it. Change the wire and exactly one of the
 * two goes red — which is how a spine that quietly stopped splitting its rounds
 * is caught by something other than a person noticing.
 */
describe('the backend fixture, read by the round walker', () => {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../../../../tests/fixtures/herleitung/two_search_rounds_steps.json',
          import.meta.url
        )
      ),
      'utf-8'
    )
  ) as RoundStep[]

  const rounds = retrievalRounds(fixture)

  test('two fetches, in index order', () => {
    expect(rounds.map((r) => r.index)).toEqual([0, 1])
  })

  test('each round owns the file THAT fetch returned', () => {
    expect(rounds[0]?.sourceNames).toEqual(['OIB-RL_2.pdf'])
    expect(rounds[1]?.sourceNames).toEqual(['Brandschutzkonzept.pdf'])
  })

  test('each round speaks its own checkpoint, never the query (PF-12)', () => {
    expect(rounds[0]?.reason).toBe('Ich brauche zuerst die Grundregel für Fluchtweglängen.')
    expect(rounds[1]?.reason).toBe('Die Grundregel steht; offen ist der Treppenraum.')
    expect(rounds[0]?.values?.query).toBe('Fluchtweglänge GK4')
    expect(rounds[1]?.values?.query).toBe('Treppenraum Entrauchung')
    for (const round of rounds) {
      expect(round.reason).not.toContain(round.values?.query)
    }
  })

  test('the merged tool step sits AHEAD of round 1 — stream order alone would strand it', () => {
    const names = fixture.map((step) => step.functionName)
    expect(names.indexOf('knowledge_search')).toBeLessThan(names.indexOf('status:retrieval:1'))
  })
})
