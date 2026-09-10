/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { retrievalRounds } from './retrieval-rounds'
import type { ThinkingStep } from '../types'

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
      },
    ])
  })
})
