/**
 * @vitest-environment node
 */
/**
 * The one fold (`docs/design/chat-wire-v2.md` §e.1), over every recorded turn in
 * `shared/wire/v2/` and the synthetic cases the recordings do not hold.
 */
import { describe, expect, it } from 'vitest'
import type { WireEvent } from '@/adapters/api/wire-v2'
import { WIRE_TURN_FILES, eventOf, frameOf, wireEvents } from '@/test-utils/wire-v2-fixtures'
import { foldTurnEvent, foldTurnEvents, type TurnView } from './turn-fold'

const fold = (events: readonly WireEvent[]): TurnView => {
  const view = foldTurnEvents(undefined, events)
  if (!view) throw new Error('no events')
  return view
}

const body = (seq: number, raw: Record<string, unknown>): WireEvent => eventOf(frameOf(seq, raw))
const delta = (seq: number, text: string) => body(seq, { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a', delta: text })
const card = (seq: number, index: number, key: string, title = key) =>
  body(seq, { type: 'CUSTOM', name: 'card', value: { index, key, card: { type: 'summary', title, content: 'x' } } })
const finished = (seq: number, result: Record<string, unknown>, outcome = 'answered') =>
  body(seq, { type: 'RUN_FINISHED', outcome, result: { message_id: 'a', ...result } })

describe('every recorded turn', () => {
  it.each(WIRE_TURN_FILES)('%s folds to a finished or failed view with every seq applied', (name) => {
    const events = wireEvents(name)
    const view = fold(events)
    expect(view.lastSeq).toBe(events.at(-1)?.seq)
    expect(view.gap).toBe(false)
    expect(view.phase).not.toBe('running')
    expect(view.streaming).toBe(false)
    expect(view.interaction).toBeUndefined()
    expect(Object.values(view.steps).every((step) => step.isComplete)).toBe(true)
  })

  it.each(WIRE_TURN_FILES)('%s folds to the same view whichever way it is split', (name) => {
    const events = wireEvents(name)
    const half = Math.floor(events.length / 2)
    expect(foldTurnEvents(fold(events.slice(0, half)), events.slice(half))).toEqual(fold(events))
  })
})

describe('turn-answered', () => {
  const events = wireEvents('turn-answered.jsonl')
  const view = fold(events)
  const result = events.flatMap((event) => (event.type === 'RUN_FINISHED' ? [event.result] : []))[0]

  it('takes the terminal as authoritative', () => {
    expect(view.outcome).toBe('answered')
    expect(view.messageId).toBe(result.message_id)
    expect(view.text).toBe(result.text)
    expect(view.sources).toEqual(result.sources)
    expect(view.answerMeta).toEqual(result.answer_meta)
    expect(view.cards).toEqual(result.cards)
    expect(view.result).toBe(result)
  })

  it('keeps the live card object when the terminal carries the same key', () => {
    const streamed = fold(events.slice(0, 15))
    const live = streamed.cards[0]
    expect(live).toBeDefined()
    expect(foldTurnEvents(streamed, events.slice(15))?.cards[0]).toBe(live)
  })

  it('stores steps in first-seen order, newest wins, in the persisted shape', () => {
    expect(view.stepOrder).toEqual([
      'status:documents',
      'status:retrieval:0',
      'status:checkpoint:0',
      'tool:call_7Qd2',
      'sources:0:knowledge_search:1',
      'skill:oib-brandschutznachweis',
      'status:synthesis',
    ])
    const tool = view.steps['tool:call_7Qd2']
    expect(tool).toMatchObject({ kind: 'tool', tool: 'knowledge_search', isComplete: true, userMessageId: view.turnId })
    // The row keeps the time it opened, not the time it finished.
    expect(tool.timestamp).toBe(new Date(events[4].ts).toISOString())
  })

  it('hoists live keys only: a technical record has nothing for the live line', () => {
    expect(view.steps['status:documents'].turnEvent).toEqual({ key: 'status.documents.project' })
    expect(view.steps['status:checkpoint:0']).toMatchObject({ slot: 'checkpoint:0', detail: { round: 0 } })
    expect(view.steps['status:checkpoint:0'].turnEvent).toBeUndefined()
    expect(view.steps['status:retrieval:0']).toMatchObject({
      kind: 'retrieval',
      round: 0,
      turnEvent: {
        key: 'status.retrieval.withQuery',
        values: { corpus: 'knowledge', query: 'Fluchtweglänge GK 4' },
        tools: ['knowledge_search'],
      },
    })
    expect(view.steps['skill:oib-brandschutznachweis']).toMatchObject({
      kind: 'skill',
      skill: 'oib-brandschutznachweis',
      turnEvent: { key: 'skill.activated', values: { skill: 'Brandschutznachweis' } },
    })
  })

  it('stores a sources step’s lanes as they came, with their signal', () => {
    const step = view.steps['sources:0:knowledge_search:1']
    expect(step).toMatchObject({ kind: 'sources', tool: 'knowledge_search', round: 0 })
    expect(step.traceLanes?.[0]).toEqual({
      key: 'baurecht_oib',
      label: 'OIB-Richtlinie',
      kind: 'baurecht',
      signal: 'law',
      hitCount: 3,
      sources: [
        { name: 'oib-rl_2_ausgabe_mai_2023.pdf', title: 'OIB-Richtlinie 2, Ausgabe Mai 2023', detail: 'Pkt. 5.1.1 p.12', shelf: 'base', round: 0 },
        { name: 'oib-rl_2_ausgabe_mai_2023.pdf', title: 'OIB-Richtlinie 2, Ausgabe Mai 2023', detail: 'Tabelle 2b p.14', shelf: 'base', round: 0 },
      ],
    })
    expect(step.traceLanes?.[1]).toMatchObject({ key: 'projekt', signal: 'project', sources: [{ name: 'Brandschutzkonzept_V3.pdf' }] })
  })

  it('shows the masthead before the first word and streams the text', () => {
    const early = fold(events.slice(0, 11))
    expect(early.answerMeta).toEqual({ kind: 'ruling', topic: 'Fluchtweglänge', verdict: '40 m', summary: 'Bei GK 4 höchstens 40 m.' })
    const midway = fold(events.slice(0, 14))
    expect(midway.streaming).toBe(true)
    expect(midway.text.startsWith('Für **Gebäudeklasse 4**')).toBe(true)
    expect(fold(events.slice(0, 17)).streaming).toBe(false)
  })

  it('marks a refused card as null and keeps the others', () => {
    expect(fold(events.slice(0, 19)).cards[1]).toBeNull()
  })

  it('records the heartbeat and both stages after the terminal', () => {
    expect(view.beatEveryMs).toBe(20_000)
    expect(view.stages.follow_ups?.status).toBe('ready')
    expect(view.stages.memory_reflection?.status).toBe('empty')
  })
})

describe('the other recorded outcomes', () => {
  it('cancelled: the partial text the server kept', () => {
    const view = fold(wireEvents('turn-cancelled.jsonl'))
    expect(view).toMatchObject({ phase: 'finished', outcome: 'cancelled', text: 'Nach § 87 der Wiener Bauordnung' })
  })

  it('error: failed with the code, the steps closed, the text kept', () => {
    const view = fold(wireEvents('turn-error.jsonl'))
    expect(view.phase).toBe('failed')
    expect(view.error).toEqual({ code: 'workflow_error', message: expect.stringContaining('unexpected error') })
    expect(view.result).toBeUndefined()
  })

  it('HITL then hand-off: the prompt opens and closes, the run is on the result', () => {
    const events = wireEvents('turn-hitl-handoff.jsonl')
    const asking = fold(events.slice(0, 4))
    expect(asking.interaction).toMatchObject({ interaction_id: 'ask_01J9Z6', input: 'choice' })
    expect(asking.steps.clarification).toMatchObject({ kind: 'clarification', detail: { max_turns: 3 } })
    expect(fold(events.slice(0, 6)).interaction).toBeUndefined()
    const view = fold(events)
    expect(view.outcome).toBe('handed_off')
    expect(view.result?.run?.run_id).toBeTruthy()
  })

  it('retracted: the tool round’s text goes, the answer that follows stays', () => {
    const events = wireEvents('turn-retracted.jsonl')
    expect(fold(events.slice(0, 3)).text).toBe('Ich sehe mir dazu die Richtlinie an.')
    const retracted = fold(events.slice(0, 4))
    expect(retracted).toMatchObject({ text: '', streaming: false, sources: [], cards: [] })
    expect(fold(events).text).toBe('Ein Geländer muss mindestens 1,00 m hoch sein.')
  })

  it('refused: the terminal replaces what streamed, cards and masthead included', () => {
    const view = fold([
      body(1, { type: 'RUN_STARTED', message_id: 'a' }),
      body(2, { type: 'CUSTOM', name: 'masthead', value: { answer_meta: { kind: 'ruling' } } }),
      delta(3, 'Anfang'),
      card(4, 0, 'k1'),
      finished(5, { text: 'Dazu kann ich nichts sagen.' }, 'refused'),
    ])
    expect(view).toMatchObject({ outcome: 'refused', text: 'Dazu kann ich nichts sagen.', cards: [], sources: [] })
    expect(view.answerMeta).toBeUndefined()
  })
})

describe('seq', () => {
  const events = [
    body(1, { type: 'RUN_STARTED', message_id: 'a' }),
    delta(2, 'Ja, '),
    delta(3, 'ab drei '),
    delta(4, 'Geschossen.'),
  ]

  it('drops a duplicate and keeps the object', () => {
    const view = fold(events.slice(0, 3))
    expect(foldTurnEvent(view, events[1])).toBe(view)
    expect(foldTurnEvent(view, events[2])).toBe(view)
  })

  it('flags a gap without applying past it, and the replay fills it', () => {
    const view = fold(events.slice(0, 2))
    const gapped = foldTurnEvent(view, events[3])
    expect(gapped).toMatchObject({ gap: true, lastSeq: 2, text: 'Ja, ' })
    // A second event past the gap changes nothing more.
    expect(foldTurnEvent(gapped, events[3])).toBe(gapped)
    // attach{after_seq: 2} replays 3 and 4.
    const filled = foldTurnEvents(gapped, events.slice(2))
    expect(filled).toMatchObject({ gap: false, lastSeq: 4, text: 'Ja, ab drei Geschossen.' })
  })

  it('takes a first event at any seq: a spectator joins mid-turn', () => {
    expect(foldTurnEvent(undefined, events[2])).toMatchObject({ lastSeq: 3, text: 'ab drei ', gap: false })
  })

  it('never folds seq 0: a rejection is the driver’s', () => {
    const view = fold(events.slice(0, 2))
    const rejected = eventOf(frameOf(0, { type: 'CUSTOM', name: 'rejected', value: { of: 'cancel_turn', code: 'not_asker' } }))
    expect(foldTurnEvent(view, rejected)).toBe(view)
  })
})

describe('cards and snapshots', () => {
  it('keeps the object when a card with an equal key arrives again', () => {
    const view = fold([card(1, 0, 'k1')])
    expect(foldTurnEvent(view, card(2, 0, 'k1')).cards).toBe(view.cards)
    expect(foldTurnEvent(view, card(2, 0, 'k2')).cards[0]?.key).toBe('k2')
  })

  it('holds a card that arrives before its marker at its index', () => {
    const view = fold([card(1, 1, 'second')])
    expect(view.cards).toHaveLength(2)
    expect(view.cards[0]).toBeUndefined()
    expect(view.cards[1]?.key).toBe('second')
  })

  it('lets a snapshot replace text, sources and masthead, and leaves the cards', () => {
    const view = fold([
      body(1, { type: 'CUSTOM', name: 'masthead', value: { answer_meta: { kind: 'ruling' } } }),
      delta(2, 'roh'),
      card(3, 0, 'k1'),
      body(4, { type: 'STATE_SNAPSHOT', snapshot: { text: 'geprüft', sources: [{ content: 'x', number: 1 }] } }),
    ])
    expect(view.text).toBe('geprüft')
    expect(view.sources).toHaveLength(1)
    expect(view.answerMeta).toBeUndefined()
    expect(view.cards[0]?.key).toBe('k1')
  })

  it('replaces a step by id, newest wins, and keeps its place', () => {
    const view = fold([
      body(1, { type: 'STEP_STARTED', step: { id: 'tool:1', kind: 'tool', tool: 'ris_search' } }),
      body(2, { type: 'STEP_FINISHED', step: { id: 'status:synthesis', kind: 'status', slot: 'synthesis', key: 'status.synthesis' } }),
      body(3, { type: 'STEP_FINISHED', step: { id: 'tool:1', kind: 'tool', tool: 'ris_search', status: 'error', scope: 'deep' } }),
    ])
    expect(view.stepOrder).toEqual(['tool:1', 'status:synthesis'])
    expect(view.steps['tool:1']).toMatchObject({ isComplete: true, scope: 'deep', detail: { status: 'error' } })
  })

  it('ignores the resolution of a prompt it is not showing', () => {
    const view = fold([
      body(1, {
        type: 'CUSTOM',
        name: 'interaction_request',
        value: { interaction_id: 'a', input: 'text', text: 'Welche GK?', expires_at: 1 },
      }),
    ])
    const other = body(2, { type: 'CUSTOM', name: 'interaction_resolved', value: { interaction_id: 'b', outcome: 'answered' } })
    expect(foldTurnEvent(view, other).interaction?.interaction_id).toBe('a')
  })
})

describe('a skill row replaced by a later phase', () => {
  it('keeps the authored title the activation carried', () => {
    const step = { id: 'skill:oib-brandschutznachweis', kind: 'skill', skill: 'oib-brandschutznachweis' }
    const view = foldTurnEvents(undefined, [
      eventOf(frameOf(1, { type: 'RUN_STARTED', message_id: 'answer-1' })),
      eventOf(frameOf(2, { type: 'STEP_FINISHED', step: { ...step, phase: 'activated', title: 'Brandschutznachweis' } })),
      eventOf(frameOf(3, { type: 'STEP_FINISHED', step: { ...step, phase: 'loaded' } })),
    ])
    expect(view?.steps[step.id]?.detail).toMatchObject({ phase: 'loaded', title: 'Brandschutznachweis' })
  })
})
