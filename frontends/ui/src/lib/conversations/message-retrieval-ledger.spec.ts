import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sanitizeRetrievalLedger } from './message-retrieval-ledger'

/**
 * The Python↔TS crossing, pinned to one artifact: the backend's ledger builder
 * produces this fixture (`tests/aiq_agent/agents/piloti/test_retrieval_ledger.py`
 * asserts it still does), and this side asserts the sanitizer passes it
 * through shape-shifted (snake_case wire in, bounded camelCase out). A renamed
 * key or a moved cap on either side fails one of the two tests instead of
 * shipping green with the Herleitung's account silently dropped.
 */
const FIXTURE_PATH = resolve(__dirname, '../../../../../tests/fixtures/herleitung/retrieval_ledger_wire.json')

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as unknown

describe('sanitizeRetrievalLedger', () => {
  test('the backend-built wire payload survives shape-shifted', () => {
    expect(sanitizeRetrievalLedger(fixture)).toEqual([
      {
        index: 0,
        key: 'status.retrieval.withQuery',
        tools: ['knowledge_search'],
        corpora: ['knowledge'],
        purpose: 'first_search',
        query: 'Fluchtweglänge GK4',
        docs: [
          { name: 'OIB-RL_2.pdf', title: 'OIB-Richtlinie 2, Ausgabe Mai 2023' },
          { name: 'Brandschutzkonzept.pdf' },
        ],
        newDocs: ['OIB-RL_2.pdf', 'Brandschutzkonzept.pdf'],
        hits: 2,
        documents: 2,
      },
      {
        index: 1,
        key: 'status.retrieval.punkt',
        tools: ['read_passage'],
        corpora: ['knowledge'],
        purpose: 'open',
        reason: 'Die Grundregel steht.',
        docs: [
          {
            name: 'OIB-RL_2.pdf',
            title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
            detail: 'p.12',
          },
          { name: 'Brandschutzkonzept.pdf', detail: 'p.3' },
        ],
        newDocs: [],
        hits: 2,
        documents: 2,
      },
    ])
  })

  test('nothing usable yields null, never an empty array', () => {
    expect(sanitizeRetrievalLedger(undefined)).toBeNull()
    expect(sanitizeRetrievalLedger('ledger')).toBeNull()
    expect(sanitizeRetrievalLedger([])).toBeNull()
    expect(sanitizeRetrievalLedger([{}])).toBeNull()
  })

  test('an entry without an index is corrupt and skipped, the rest survives', () => {
    const ledger = sanitizeRetrievalLedger([{ key: 'status.retrieval.plain' }, ...(fixture as unknown[])])
    expect(ledger).toHaveLength(2)
    expect(ledger?.[0]?.index).toBe(0)
  })

  test('an announced round with no docs is kept — found nothing is still news', () => {
    const ledger = sanitizeRetrievalLedger([
      { index: 0, key: 'status.retrieval.plain', tools: ['knowledge_search'], docs: [], new_docs: [] },
    ])
    expect(ledger).toHaveLength(1)
    expect(ledger?.[0]?.docs).toEqual([])
  })

  test('an over-long query is truncated, not dropped whole', () => {
    const ledger = sanitizeRetrievalLedger([{ index: 0, key: 'k', query: 'x'.repeat(100) }])
    expect(ledger?.[0]?.query).toHaveLength(32)
  })

  test('an unknown purpose stays a string for the renderer to read generically', () => {
    const ledger = sanitizeRetrievalLedger([{ index: 0, key: 'k', purpose: 'requery' }])
    expect(ledger?.[0]?.purpose).toBe('requery')
  })

  test('rounds are capped, docs per round are capped', () => {
    const ledger = sanitizeRetrievalLedger(
      Array.from({ length: 20 }, (_, i) => ({
        index: i,
        key: 'k',
        docs: Array.from({ length: 200 }, (_, j) => ({ name: `d${j}.pdf` })),
      })),
    )
    expect(ledger).toHaveLength(12)
    expect(ledger?.[0]?.docs).toHaveLength(100)
  })
})
