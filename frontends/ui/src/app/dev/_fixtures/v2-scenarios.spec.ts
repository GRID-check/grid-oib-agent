/**
 * @vitest-environment node
 */
/**
 * `/dev/stream-socket?scenario=` plays turns no backend recorded, so each is
 * held to the wire contract here: every frame parses as a v2 event, seq runs
 * 1..n in time order, no frame but the settle and the terminal is over 4 KB,
 * and folded the way the store folds it the turn ends in the shape its name
 * promises. A scenario that drifted off the contract would measure a turn the
 * product can never receive.
 */
import { describe, expect, it } from 'vitest'
import { parseWireEvent, type WireEvent } from '@/adapters/api/wire-v2'
import { foldTurnEvents, type TurnView } from '@/features/chat/lib/turn-fold'
import { buildTurnScript } from '../stream-socket/turn-script'
import { STREAM_FRAMES } from './stream-frames'
import { ERROR_PHASES, STREAM_SCENARIOS, v2Scenario, type ErrorPhase, type StreamScenario } from './v2-scenarios'
import type { TimedFrame } from './v2-turn'

const IDS = { conversationId: 'c', turnId: 't', messageId: 'm' }
/** What the settle carries, and what the product's terminal repeats today. */
const SETTLED = STREAM_FRAMES.oib2.frames.find((frame) => frame.stream_replace)!
const SETTLED_TEXT = SETTLED.content

const framesOf = (name: StreamScenario, error?: ErrorPhase): TimedFrame[] => v2Scenario(name, STREAM_FRAMES.oib2, IDS, 1, error)
const eventsOf = (frames: TimedFrame[]): WireEvent[] =>
  frames.map(({ frame }) => {
    const event = parseWireEvent(frame)
    if (!event) throw new Error(`not a v2 event: ${JSON.stringify(frame).slice(0, 160)}`)
    return event
  })
const fold = (name: StreamScenario, error?: ErrorPhase): TurnView => foldTurnEvents(undefined, eventsOf(framesOf(name, error)))!
const typesOf = (frames: TimedFrame[]) => frames.map(({ frame }) => String(frame.name ?? frame.type))
const atOf = (frames: TimedFrame[], type: string) => frames.find(({ frame }) => (frame.name ?? frame.type) === type)?.at

const cases = STREAM_SCENARIOS.flatMap((name) => [
  [name, undefined] as const,
  ...ERROR_PHASES.map((phase) => [name, phase] as const),
])

describe.each(cases)('scenario %s, error %s', (name, error) => {
  const frames = framesOf(name, error)

  it('is a v2 turn: every frame parses, seq 1..n in time order, one terminal last but the stage', () => {
    eventsOf(frames)
    expect(frames.map(({ frame }) => frame.seq)).toEqual(frames.map((_, index) => index + 1))
    expect(frames.map(({ at }) => at)).toEqual([...frames.map(({ at }) => at)].sort((a, b) => a - b))
    const terminals = frames.filter(({ frame }) => frame.type === 'RUN_FINISHED' || frame.type === 'RUN_ERROR')
    expect(terminals).toHaveLength(1)
    expect(frames.at(-1)!.frame.name === 'stage' ? frames.at(-2) : frames.at(-1)).toBe(terminals[0])
  })

  it('keeps every frame but the terminal and the settle under 4 KB', () => {
    const encoder = new TextEncoder()
    const oversized = frames
      .filter(({ frame }) => frame.type !== 'RUN_FINISHED' && frame.type !== 'STATE_SNAPSHOT')
      .filter(({ frame }) => encoder.encode(JSON.stringify(frame)).length > 4096)
    expect(typesOf(oversized)).toEqual([])
  })

  it(error ? `fails at ${error}` : 'finishes answered', () => {
    const view = fold(name, error)
    expect(view.phase).toBe(error ? 'failed' : 'finished')
  })
})

describe('each scenario is the shape its name says', () => {
  it('cards-only: two cards and no prose', () => {
    const view = fold('cards-only')
    expect(view.text).toBe('')
    expect(view.cards).toHaveLength(2)
    expect(typesOf(framesOf('cards-only'))).not.toContain('TEXT_MESSAGE_CONTENT')
  })

  it('masthead-first: the masthead stands alone for over a second before the first word', () => {
    const frames = framesOf('masthead-first')
    expect(atOf(frames, 'TEXT_MESSAGE_CONTENT')! - atOf(frames, 'masthead')!).toBeGreaterThanOrEqual(1_000)
    expect(fold('masthead-first').text).toBe(SETTLED_TEXT)
  })

  it('shallow: no steps at all, the answer from 600 ms', () => {
    const frames = framesOf('shallow')
    expect(typesOf(frames).filter((type) => type.startsWith('STEP_'))).toEqual([])
    expect(atOf(frames, 'masthead')).toBe(600)
  })

  it('opens-table: the first block streamed is a table', () => {
    expect(fold('opens-table').text).toMatch(/^\| Nachweis \| Anforderung \| Fundstelle \|\n\|---/)
  })

  it('opens-card: the card arrives before the prose that places it first', () => {
    const frames = framesOf('opens-card')
    const view = fold('opens-card')
    expect(atOf(frames, 'card')!).toBeLessThan(atOf(frames, 'TEXT_MESSAGE_CONTENT')!)
    expect(view.text.startsWith('[[card:1]]')).toBe(true)
    expect(view.cards).toHaveLength(1)
  })

  it('one-line: a single delta, the text one line', () => {
    expect(typesOf(framesOf('one-line')).filter((type) => type === 'TEXT_MESSAGE_CONTENT')).toHaveLength(1)
    expect(fold('one-line').text).not.toContain('\n')
  })

  it('long: the recorded prose six times over', () => {
    const recordedProse = STREAM_FRAMES.oib2.frames
      .filter((frame) => !frame.stream_replace && frame.status !== 'complete')
      .map((frame) => frame.content)
      .join('')
    expect(fold('long').text.length).toBeGreaterThan(recordedProse.length * 6)
  })

  it('retract-with-card: the preamble and its card are taken back, the recorded answer stays', () => {
    const frames = framesOf('retract-with-card')
    expect(atOf(frames, 'card')!).toBeLessThan(atOf(frames, 'answer_retracted')!)
    const view = fold('retract-with-card')
    expect(view.text).toBe(SETTLED_TEXT)
    expect(view.cards).toEqual([])
  })

  it('two-turns: two questions, two answers with their own ids', () => {
    const script = buildTurnScript(1, { scenario: 'two-turns' })
    expect(script.turns.map((turn) => turn.question)).toEqual([STREAM_FRAMES.oib2.question, STREAM_FRAMES.varianten.question])
    const answerIds = script.turns.map((turn) => (JSON.parse(turn.frames[0].data) as { message_id: string }).message_id)
    expect(new Set(answerIds).size).toBe(2)
  })
})

describe('the terminal continues the settle, but in rewrite', () => {
  const lastSnapshotText = (frames: TimedFrame[]) =>
    (frames.findLast(({ frame }) => frame.type === 'STATE_SNAPSHOT')?.frame.snapshot as { text: string } | undefined)?.text
  const terminalOf = (frames: TimedFrame[]) =>
    frames.find(({ frame }) => frame.type === 'RUN_FINISHED')!.frame.result as { text: string; sources: unknown[]; cards: unknown[] }

  it.each(STREAM_SCENARIOS.filter((name) => name !== 'rewrite' && name !== 'cards-only'))(
    '%s: RUN_FINISHED carries the settled text, as ADR-0067 left the repair',
    (name) => {
      const frames = framesOf(name)
      expect(terminalOf(frames).text).toBe(lastSnapshotText(frames))
    }
  )

  it('happy: the terminal is the settle, its sources and the cards that streamed', () => {
    const frames = framesOf('happy')
    const terminal = terminalOf(frames)
    expect(terminal.text).toBe(SETTLED_TEXT)
    expect(terminal.sources).toEqual(SETTLED.sources)
    const streamed = frames.filter(({ frame }) => frame.name === 'card').map(({ frame }) => frame.value)
    expect(terminal.cards).toHaveLength(streamed.length)
  })

  it('rewrite: the recording as it was, a terminal that replaces the settled answer', () => {
    const frames = framesOf('rewrite')
    const recorded = STREAM_FRAMES.oib2.frames.at(-1)!
    expect(terminalOf(frames).text).toBe(recorded.content)
    expect(terminalOf(frames).text).not.toBe(lastSnapshotText(frames))
    expect(fold('rewrite').text).toBe(recorded.content)
  })
})

describe('each error phase cuts the turn where its name says', () => {
  it('preack: nothing but the ack before the error', () => {
    expect(typesOf(framesOf('happy', 'preack'))).toEqual(['RUN_STARTED', 'RUN_ERROR'])
  })

  it('steps: some steps, no answer yet', () => {
    const view = fold('happy', 'steps')
    expect(view.stepOrder.length).toBeGreaterThan(0)
    expect(view.text).toBe('')
  })

  it('prose: part of the answer', () => {
    const view = fold('happy', 'prose')
    expect(view.text.length).toBeGreaterThan(0)
    expect(view.text.length).toBeLessThan(SETTLED_TEXT.length * 4)
    expect(typesOf(framesOf('happy', 'prose'))).not.toContain('STATE_SNAPSHOT')
  })

  it('finish: the whole answer, settled, then the error instead of the terminal', () => {
    const frames = framesOf('happy', 'finish')
    expect(typesOf(frames)).toContain('STATE_SNAPSHOT')
    expect(typesOf(frames)).toContain('TEXT_MESSAGE_END')
    expect(fold('happy', 'finish').text.length).toBeGreaterThan(0)
  })
})
