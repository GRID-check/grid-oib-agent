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

const ROUND_0 = {
  index: 0,
  key: 'status.retrieval.withQuery',
  tools: ['knowledge_search'],
  corpora: ['knowledge'],
  query: 'Fluchtweglänge GK4',
  docs: [
    { name: 'OIB-RL_2.pdf', title: 'OIB-Richtlinie 2, Ausgabe Mai 2023', repeat: false },
    { name: 'Brandschutzkonzept.pdf', repeat: false },
  ],
  newDocs: ['OIB-RL_2.pdf', 'Brandschutzkonzept.pdf'],
  hits: 2,
  documents: 2,
}

const ROUND_1 = {
  index: 1,
  key: 'status.retrieval.punkt',
  tools: ['read_passage'],
  corpora: ['knowledge'],
  reason: 'Die Grundregel steht.',
  docs: [
    {
      name: 'OIB-RL_2.pdf',
      title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
      detail: 'p.12',
      repeat: false,
    },
    { name: 'Brandschutzkonzept.pdf', detail: 'p.3', repeat: false },
  ],
  newDocs: ['OIB-RL_2.pdf', 'Brandschutzkonzept.pdf'],
  hits: 2,
  documents: 2,
}

/** One file, three Punkte — the round the fan folds to a single card. */
const ROUND_2 = {
  index: 2,
  key: 'status.retrieval.punkt',
  tools: ['read_passage'],
  corpora: ['knowledge'],
  reason: 'Die Fluchtweglänge hängt an drei Punkten.',
  docs: ['Pkt. 3.1', 'Pkt. 3.2', 'Pkt. 3.3'].map((detail) => ({
    name: 'OIB-RL_2.pdf',
    title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
    detail,
    repeat: true,
  })),
  newDocs: [],
  hits: 3,
  documents: 1,
}

describe('sanitizeRetrievalLedger', () => {
  test('the backend-built wire payload survives shape-shifted', () => {
    expect(sanitizeRetrievalLedger(fixture)).toEqual([ROUND_0, ROUND_1, ROUND_2])
  })

  test('nothing usable yields null, never an empty array', () => {
    expect(sanitizeRetrievalLedger(undefined)).toBeNull()
    expect(sanitizeRetrievalLedger('ledger')).toBeNull()
    expect(sanitizeRetrievalLedger([])).toBeNull()
    expect(sanitizeRetrievalLedger([{}])).toBeNull()
  })

  test('an entry without an index is corrupt and skipped, the rest survives', () => {
    const ledger = sanitizeRetrievalLedger([{ key: 'status.retrieval.plain' }, ...(fixture as unknown[])])
    expect(ledger).toHaveLength(3)
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

  test('tallies are derived from the docs, not trusted from the payload', () => {
    // The untrusted boundary: a tampered payload rendering "999 Treffer" over
    // one file is exactly what this sanitizer exists to stop.
    const ledger = sanitizeRetrievalLedger([
      {
        index: 0,
        key: 'k',
        docs: [{ name: 'a.pdf' }, { name: 'a.pdf', detail: 'p.2' }, { name: 'b.pdf' }],
        hits: 999,
        documents: 999,
      },
    ])
    expect(ledger?.[0]?.hits).toBe(3)
    expect(ledger?.[0]?.documents).toBe(2)
  })

  test('a passage carries the backend’s repeat verdict, and only a real boolean', () => {
    const ledger = sanitizeRetrievalLedger([
      {
        index: 0,
        key: 'k',
        docs: [
          { name: 'a.pdf', detail: 'p.12', repeat: true },
          { name: 'a.pdf', detail: 'p.60', repeat: false },
          // A stored turn from before the backend stamped it, and a payload
          // that made the field up: both render off `newDocs` instead.
          { name: 'b.pdf' },
          { name: 'c.pdf', repeat: 'ja' },
        ],
      },
    ])
    expect(ledger?.[0]?.docs.map((doc) => doc.repeat)).toEqual([true, false, undefined, undefined])
  })

  test('newDocs is filtered to names that are actually in docs', () => {
    const ledger = sanitizeRetrievalLedger([
      { index: 0, key: 'k', docs: [{ name: 'a.pdf' }], new_docs: ['a.pdf', 'ghost.pdf'] },
    ])
    expect(ledger?.[0]?.newDocs).toEqual(['a.pdf'])
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
