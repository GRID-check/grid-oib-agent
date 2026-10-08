/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test, expect } from 'vitest'
import { fixtureSteps, storedStep } from '@/test-utils/wire-v2-steps'
import { documentsForRound, retrievalRounds, roundFan, type RetrievalRound } from './retrieval-rounds'
import { sanitizeRetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'
import type { CitedDocument } from './citations/model'

const retrieval = (round: number, query: string, extra: Record<string, unknown> = {}) =>
  storedStep({
    id: `status:retrieval:${round}`,
    kind: 'retrieval',
    round,
    key: 'status.retrieval.withQuery',
    values: { corpus: 'knowledge', query },
    ...extra,
  })

const hit = (name: string, round?: number) => ({ name, ...(round !== undefined ? { round } : {}) })

const sources = (id: string, round: number | undefined, hits: Array<{ name: string; round?: number }>) =>
  storedStep({
    id,
    kind: 'sources',
    tool: 'knowledge_search',
    ...(round !== undefined ? { round } : {}),
    lanes: [{ key: 'baurecht_oib', label: 'OIB-Richtlinie', kind: 'baurecht', hit_count: hits.length, sources: hits }],
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

  test('two rounds come out in index order', () => {
    const rounds = retrievalRounds([retrieval(1, 'Überhang Dachrand'), retrieval(0, 'OIB 3 Pkt. 3.4.2')])
    expect(rounds.map((r) => r.index)).toEqual([0, 1])
    expect(rounds[1]?.values?.query).toBe('Überhang Dachrand')
  })

  test('only retrieval steps are rounds: a requery status is not one', () => {
    const requery = storedStep({
      id: 'status:retrieval:requery',
      kind: 'status',
      slot: 'retrieval:requery',
      key: 'status.retrieval.requery',
    })
    expect(retrievalRounds([requery])).toEqual([])
  })

  test('the checkpoint is the reason, never the query; tools are unique', () => {
    const [round] = retrievalRounds([
      retrieval(0, 'Fluchtweglänge GK4', {
        reason: 'Ich brauche zuerst die Grundregel.',
        tools: ['knowledge_search', 'knowledge_search', 'read_passage'],
      }),
    ])
    expect(round.reason).toBe('Ich brauche zuerst die Grundregel.')
    expect(round.tools).toEqual(['knowledge_search', 'read_passage'])
  })

  test('a sources step belongs to the round it names', () => {
    const rounds = retrievalRounds([
      retrieval(0, 'a'),
      sources('sources:0', 0, [hit('oib-rl_2.pdf')]),
      retrieval(1, 'b'),
      sources('sources:1', 1, [hit('EG_Grundriss.pdf'), hit('eg_grundriss.pdf')]),
    ])
    expect(rounds.map((r) => r.sourceNames)).toEqual([['oib-rl_2.pdf'], ['EG_Grundriss.pdf']])
  })

  test('the round stamp on a hit wins over the one on its step', () => {
    const rounds = retrievalRounds([
      retrieval(0, 'a'),
      retrieval(1, 'b'),
      sources('sources:x', 1, [hit('OIB-RL_2.pdf', 0), hit('Brandschutzkonzept.pdf')]),
    ])
    expect(rounds.map((r) => r.sourceNames)).toEqual([['OIB-RL_2.pdf'], ['Brandschutzkonzept.pdf']])
  })

  test('a recorded turn: the round owns the files its fetch returned', () => {
    const [round] = retrievalRounds(fixtureSteps('turn-answered.jsonl'))
    expect(round.index).toBe(0)
    expect(round.tools).toEqual(['knowledge_search'])
    expect(round.sourceNames.length).toBeGreaterThan(0)
    expect(round.reason).not.toContain(round.values?.query ?? '\u0000')
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
  })
})

/**
 * The fan under a round, once the backend states what that round returned.
 *
 * `documentsForRound` matches filenames, so every round that touched a file
 * would draw the same turn-level card: the same aggregate count, the same cited
 * page. A second round re-opening four files at new pages would be four
 * identical cards. The ledger says which documents a round returned and at which
 * passages; `roundFan` folds them to ONE slot per document carrying its loci, and
 * falls back to the filename match for any round it does not cover.
 */
describe('roundFan', () => {
  const doc = (id: string, fileName: string): CitedDocument => ({
    id,
    title: id,
    fileName,
    kind: 'baurecht',
    tint: 'law',
    loci: [{ key: 'whole', isCited: true }],
  })

  const oib = doc('oib', 'OIB-RL_2.pdf')
  const konzept = doc('konzept', 'Brandschutzkonzept.pdf')

  const round = (index: number, sourceNames: string[]): RetrievalRound => ({
    index,
    key: 'status.retrieval.withQuery',
    tools: ['knowledge_search'],
    sourceNames,
  })

  /**
   * The wire the Python half writes, not a copy of it — the same fixture
   * `message-retrieval-ledger.spec.ts` pins the sanitizer against. Sanitized
   * first, because that is the only shape a renderer ever sees.
   */
  const ledger = sanitizeRetrievalLedger(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            '../../../../../../tests/fixtures/herleitung/retrieval_ledger_wire.json',
            import.meta.url
          )
        ),
        'utf-8'
      )
    )
  )!

  const rounds = [
    round(0, ['OIB-RL_2.pdf']),
    round(1, ['OIB-RL_2.pdf']),
    round(2, ['OIB-RL_2.pdf']),
  ]

  const details = (fan: ReturnType<typeof roundFan>) =>
    fan.map((slot) => slot.loci?.map((locus) => locus.detail))

  test('a ledger round draws ITS docs, at the loci IT read', () => {
    const fan = roundFan(rounds[1]!, [oib, konzept], ledger)
    expect(fan.map((slot) => slot.card?.id)).toEqual(['oib', 'konzept'])
    expect(details(fan)).toEqual([['p.12'], ['p.3']])
  })

  test('five opens of one document are ONE card listing its five loci', () => {
    // Five Punkte of one Richtlinie are one card, not five identical ones: five
    // cards would read as five fetches of the same file.
    const punkte = ['Pkt. 3.1', 'Pkt. 3.2', 'Pkt. 3.3', 'Pkt. 3.4', 'Pkt. 3.5']
    const entry = {
      ...ledger[2]!,
      docs: punkte.map((detail) => ({ name: 'OIB-RL_2.pdf', detail, repeat: false })),
      newDocs: ['OIB-RL_2.pdf'],
    }
    const fan = roundFan(rounds[2]!, [oib, konzept], [ledger[0]!, ledger[1]!, entry])
    expect(fan).toHaveLength(1)
    expect(fan[0]?.card?.id).toBe('oib')
    expect(details(fan)).toEqual([punkte])
  })

  test('a search that only ranked a file does not make the later open a repeat', () => {
    // Round 0 listed both files; round 1 is the first to read into them.
    expect(roundFan(rounds[0]!, [oib, konzept], ledger).map((s) => s.loci)).toEqual([
      [{ repeat: false }],
      [{ repeat: false }],
    ])
    expect(roundFan(rounds[1]!, [oib, konzept], ledger).map((s) => s.loci)).toEqual([
      [{ detail: 'p.12', repeat: false }],
      [{ detail: 'p.3', repeat: false }],
    ])
  })

  test('a document an earlier round OPENED is marked on every locus it is read at again', () => {
    const fan = roundFan(rounds[2]!, [oib, konzept], ledger)
    expect(fan).toHaveLength(1)
    expect(fan[0]?.loci?.every((locus) => locus.repeat)).toBe(true)
  })

  test('a round that re-lists one passage and finds another marks only the first', () => {
    // Round 0 ranked the file at p.12; this round ranks it there again and
    // reaches p.60 for the first time. One card, two loci, one marker — the
    // claim a document-level verdict cannot make.
    const entry = {
      ...ledger[2]!,
      docs: [
        { name: 'OIB-RL_2.pdf', detail: 'p.12', repeat: true },
        { name: 'OIB-RL_2.pdf', detail: 'p.60', repeat: false },
      ],
      newDocs: ['OIB-RL_2.pdf'],
    }
    const fan = roundFan(rounds[2]!, [oib, konzept], [ledger[0]!, ledger[1]!, entry])
    expect(fan).toHaveLength(1)
    expect(fan[0]?.loci).toEqual([
      { detail: 'p.12', repeat: true },
      { detail: 'p.60', repeat: false },
    ])
  })

  test('a turn without passage stamps falls back to newDocs', () => {
    // Rows stored without the stamp are replayed from Postgres and must still say something true:
    // the document-level verdict, applied to every locus of that document.
    const entry = {
      ...ledger[1]!,
      docs: [
        { name: 'OIB-RL_2.pdf', detail: 'p.12' },
        { name: 'Brandschutzkonzept.pdf', detail: 'p.3' },
      ],
      newDocs: ['OIB-RL_2.pdf'],
    }
    const fan = roundFan(rounds[1]!, [oib, konzept], [ledger[0]!, entry])
    expect(fan.map((slot) => slot.loci)).toEqual([
      [{ detail: 'p.12', repeat: false }],
      [{ detail: 'p.3', repeat: true }],
    ])
  })

  test('a ledger doc with no card keeps its slot and its loci', () => {
    // The answer-repair pass reads after the cards are built; a slot dropped
    // here would have the round claim it read one file when it read two.
    const fan = roundFan(rounds[1]!, [oib], ledger)
    expect(fan.map((slot) => slot.card?.id)).toEqual(['oib', undefined])
    expect(fan[1]).toMatchObject({
      name: 'Brandschutzkonzept.pdf',
      loci: [{ detail: 'p.3', repeat: false }],
    })
  })

  test('without a ledger the fan is the filename match, and no round speaks for a slot', () => {
    const fan = roundFan(rounds[1]!, [oib, konzept])
    expect(fan.map((slot) => slot.card?.id)).toEqual(['oib'])
    expect(fan[0]?.loci).toBeUndefined()
  })

  test('a round the ledger does not have falls back on its own', () => {
    const missing = round(7, ['Brandschutzkonzept.pdf'])
    const fan = roundFan(missing, [oib, konzept], ledger)
    expect(fan.map((slot) => slot.card?.id)).toEqual(['konzept'])
    expect(fan[0]?.loci).toBeUndefined()
  })

})
