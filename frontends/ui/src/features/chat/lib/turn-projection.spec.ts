/**
 * @vitest-environment node
 */
/**
 * The projection of the terminal outcomes that do not end in an answer
 * (wave-2 audit, item 1): a commissioned run takes the answer's row at once,
 * under the id the server wrote it with, so the turn is never drawn as one
 * without a response while the stored message is fetched.
 */
import { describe, expect, it } from 'vitest'
import type { WireEvent } from '@/adapters/api/wire-v2'
import { eventOf, frameOf } from '@/test-utils/wire-v2-fixtures'
import type { ChatMessage } from '../types'
import { foldTurnEvent, type TurnView } from './turn-fold'
import { projectTurn, provisionalRunMessage } from './turn-projection'

const body = (seq: number, raw: Record<string, unknown>): WireEvent => eventOf(frameOf(seq, raw))
const RUN = { run_id: 'run-1', run_message_id: 'run-msg-1' }

const question: ChatMessage = {
  id: 'turn-1',
  role: 'user',
  content: 'Prüfe die Fluchtwege im 3. OG',
  timestamp: new Date('2026-10-01T09:00:00Z'),
  messageType: 'user',
}

/** Folds `events` one by one and projects each fold, the way the store commits them. */
const play = (events: readonly WireEvent[], start: ChatMessage[] = [question]): ChatMessage[] => {
  let messages = start
  let view: TurnView | undefined
  for (const event of events) {
    const previous = view
    view = foldTurnEvent(view, event)
    messages = projectTurn(messages, view, previous, { draft: '' }).messages
  }
  return messages
}

const preamble = [
  body(1, { type: 'RUN_STARTED', message_id: 'answer-1' }),
  body(2, { type: 'TEXT_MESSAGE_START', message_id: 'answer-1' }),
  body(3, {
    type: 'TEXT_MESSAGE_CONTENT',
    message_id: 'answer-1',
    delta: 'Ich gebe das an eine Recherche ab.',
  }),
  body(4, { type: 'TEXT_MESSAGE_END', message_id: 'answer-1' }),
]
const handedOff = (seq: number) =>
  body(seq, {
    type: 'RUN_FINISHED',
    outcome: 'handed_off',
    result: { message_id: 'answer-1', text: '', run: RUN },
  })

describe('handed_off', () => {
  it('swaps the answer for a provisional run message in the same row', () => {
    // A row after the answer (a later question) shows the swap is in place,
    // not a removal and an append.
    const drawn = play(preamble)
    const later: ChatMessage = { ...question, id: 'other', content: 'danach' }
    let view: TurnView | undefined
    for (const event of preamble) view = foldTurnEvent(view, event)
    const messages = projectTurn([...drawn, later], foldTurnEvent(view, handedOff(5)), view, {
      draft: '',
    }).messages
    expect(messages.map((m) => m.id)).toEqual(['turn-1', 'run-msg-1', 'other'])
    const run = messages[1]!
    expect(run).toMatchObject({ role: 'assistant', messageType: 'agent_response', content: '' })
    expect(run.runLedger).toMatchObject({ runId: 'run-1', status: 'angelegt', steps: [] })
    expect(run.runTitle).toBe('Prüfe die Fluchtwege im 3. OG')
  })

  it('draws the block even when nothing streamed before the hand-off', () => {
    const messages = play([body(1, { type: 'RUN_STARTED', message_id: 'answer-1' }), handedOff(2)])
    expect(messages.map((m) => m.id)).toEqual(['turn-1', 'run-msg-1'])
  })

  it('keeps an adopted (stored) run message and draws no second block', () => {
    const stored: ChatMessage = {
      ...provisionalRunMessage('run-1', 'run-msg-1'),
      runTitle: 'Stored',
    }
    const messages = play(
      [
        ...preamble,
        handedOff(5),
        body(6, {
          type: 'CUSTOM',
          name: 'stage',
          value: { stage: 'memory_reflection', status: 'empty' },
        }),
      ],
      [question, stored]
    )
    expect(messages.map((m) => m.id)).toEqual(['turn-1', 'run-msg-1'])
    expect(messages[1]).toBe(stored)
  })

  it('stamps the provisional ledger older than any the server writes', () => {
    const { runLedger } = provisionalRunMessage('run-1', 'run-msg-1')
    expect(runLedger!.updatedAt < '2000-01-01T00:00:00.000Z').toBe(true)
    expect(runLedger!.startedAt > '2026-01-01T00:00:00.000Z').toBe(true)
  })
})

describe('the other ends', () => {
  it('job_admission_rejected: the answer leaves, the banner speaks', () => {
    const messages = play([
      ...preamble,
      body(5, {
        type: 'RUN_FINISHED',
        outcome: 'refused',
        result: {
          message_id: 'answer-1',
          text: 'Die Warteschlange ist voll.',
          job_admission_rejected: true,
          retry_after_seconds: 30,
        },
      }),
    ])
    expect(messages.map((m) => m.id)).toEqual(['turn-1'])
  })

  it('cancelled: the answer stays, marked stopped', () => {
    const messages = play([
      ...preamble,
      body(5, {
        type: 'RUN_FINISHED',
        outcome: 'cancelled',
        result: { message_id: 'answer-1', text: 'Ich gebe das' },
      }),
    ])
    expect(messages[1]).toMatchObject({ id: 'answer-1', stopped: true, content: 'Ich gebe das' })
  })

  it('RUN_ERROR: the projection keeps what streamed, marked failed in the same frame', () => {
    const messages = play([
      ...preamble,
      body(5, { type: 'RUN_ERROR', code: 'workflow_error', message: 'boom' }),
    ])
    expect(messages[1]).toMatchObject({
      id: 'answer-1',
      content: 'Ich gebe das an eine Recherche ab.',
      failed: true,
    })
    expect(messages[1]!.isStreaming).toBeUndefined()
  })
})

describe('the level the answer ran at', () => {
  const finishedAt = (effort?: string | null) =>
    body(5, {
      type: 'RUN_FINISHED',
      outcome: 'answered',
      result: {
        message_id: 'answer-1',
        text: 'Fertig.',
        ...(effort !== undefined ? { reasoning_effort: effort } : {}),
      },
    })

  /** `play`, with the turn opened the way `beginTurn` opens it when this page asked at `effort`. */
  const playAsked = (effort: TurnView['effort'], events: readonly WireEvent[]): ChatMessage[] => {
    let messages: ChatMessage[] = [question]
    let view: TurnView | undefined
    for (const event of events) {
      const previous = view
      const folded = foldTurnEvent(view, event)
      view = effort ? { ...folded, effort } : folded
      messages = projectTurn(messages, view, previous, { draft: '' }).messages
    }
    return messages
  }

  it("is the terminal's report for an observer, who holds no record of its own", () => {
    expect(play([...preamble, finishedAt('high')])[1]!.reasoningEffort).toBe('high')
  })

  it("is the terminal's report over the asker's record, and stays so on later folds", () => {
    const later = body(6, {
      type: 'STEP_STARTED',
      step: { id: 's', kind: 'status', slot: 'x', channel: 'technical' },
    })
    const messages = playAsked('low', [...preamble, finishedAt('xhigh'), later])
    expect(messages[1]!.reasoningEffort).toBe('xhigh')
  })

  it("is the asker's record until the terminal reports one, and when it reports none", () => {
    expect(playAsked('low', preamble)[1]!.reasoningEffort).toBe('low')
    expect(playAsked('low', [...preamble, finishedAt()])[1]!.reasoningEffort).toBe('low')
    // `none` is no level the dial offers: the record stands.
    expect(playAsked('low', [...preamble, finishedAt('none')])[1]!.reasoningEffort).toBe('low')
  })
})
