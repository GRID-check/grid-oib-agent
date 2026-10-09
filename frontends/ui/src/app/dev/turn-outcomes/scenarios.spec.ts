/**
 * @vitest-environment node
 */
/**
 * The `/dev/turn-outcomes` scripts are real v2 turns: every body passes the
 * wire contract, and folded and projected the way the store does it, each
 * scenario ends the way its note says. A preview that drifted off the
 * contract would show a turn no backend can send.
 */
import { describe, expect, it } from 'vitest'
import { parseWireEvent, type WireEvent } from '@/adapters/api/wire-v2'
import { foldTurnEvent, type TurnView } from '@/features/chat/lib/turn-fold'
import { projectTurn } from '@/features/chat/lib/turn-projection'
import type { ChatMessage } from '@/features/chat/types'
import {
  ANSWER_ID,
  RUN,
  SCENARIO_IDS,
  SCENARIOS,
  type ScenarioId,
  type TimedBody,
} from './scenarios'

const TURN = 'turn-q'

/** The bodies of a scenario as the server sends them: the script, then the continuation, in time order. */
const bodiesOf = (id: ScenarioId): TimedBody[] => {
  const scenario = SCENARIOS[id]
  const script = [...scenario.script].sort((a, b) => a.at - b.at)
  if (scenario.stopAt !== undefined && scenario.afterCancel) {
    const sent = script.filter((body) => body.at <= scenario.stopAt!)
    const text = sent
      .map(({ body }) => (body.type === 'TEXT_MESSAGE_CONTENT' ? String(body.delta) : ''))
      .join('')
    return [...sent, ...scenario.afterCancel(text)]
  }
  return [...script, ...(scenario.afterAnswer ?? [])]
}

const eventsOf = (id: ScenarioId): WireEvent[] =>
  bodiesOf(id).map(({ body }, index) => {
    const event = parseWireEvent({
      v: 2,
      conversation_id: 'c',
      turn_id: TURN,
      seq: index + 1,
      ts: 1,
      ...body,
    })
    if (!event)
      throw new Error(
        `${id}: body ${index} is not a v2 event: ${JSON.stringify(body).slice(0, 160)}`
      )
    return event
  })

const play = (id: ScenarioId): { view: TurnView; messages: ChatMessage[] } => {
  let messages: ChatMessage[] = [
    {
      id: TURN,
      role: 'user',
      content: SCENARIOS[id].question,
      timestamp: new Date(),
      messageType: 'user',
    },
  ]
  let view: TurnView | undefined
  for (const event of eventsOf(id)) {
    const previous = view
    view = foldTurnEvent(view, event)
    messages = projectTurn(messages, view, previous, { draft: '' }).messages
  }
  return { view: view!, messages }
}

describe('/dev/turn-outcomes scenarios', () => {
  // `error_preack` is the server that never answers: its script is silence.
  it.each(SCENARIO_IDS.filter((id) => id !== 'error_preack'))('%s: every body is a v2 event', (id) => {
    expect(eventsOf(id).length).toBeGreaterThan(0)
  })

  it('error_preack: the server sends nothing at all', () => {
    expect(SCENARIOS.error_preack.script).toEqual([])
    expect(SCENARIOS.error_preack.afterCancel).toBeUndefined()
  })

  it('handed_off: the run block stands where the preamble was', () => {
    const { view, messages } = play('handed_off')
    expect(view.outcome).toBe('handed_off')
    expect(messages.map((m) => m.id)).toEqual([TURN, RUN.run_message_id])
    expect(messages[1]!.runLedger?.runId).toBe(RUN.run_id)
  })

  it('answer_retracted: the answer that follows is the one that stays', () => {
    const { messages } = play('answer_retracted')
    expect(messages[1]).toMatchObject({ id: ANSWER_ID })
    expect(messages[1]!.content).toMatch(/^Fluchtwege müssen/)
  })

  it('run_error: the turn fails with text on screen', () => {
    const { view } = play('run_error')
    expect(view.phase).toBe('failed')
    expect(view.text.length).toBeGreaterThan(0)
  })

  it('error_steps: the turn fails with rows in the Herleitung and no answer text', () => {
    const { view, messages } = play('error_steps')
    expect(view.phase).toBe('failed')
    expect(view.stepOrder.length).toBeGreaterThan(0)
    expect(view.text).toBe('')
    expect(messages.some((m) => m.id === ANSWER_ID && m.content.length > 0)).toBe(false)
  })

  it('error_finish: the whole answer streamed, then the turn fails', () => {
    const { view } = play('error_finish')
    expect(view.phase).toBe('failed')
    expect(view.text).toMatch(/^Fluchtwege müssen/)
    expect(view.text.trim().endsWith('überschritten ist.')).toBe(true)
  })

  it('stop_before_steps: cancelled after the ack alone, with no rows and no text', () => {
    const { view } = play('stop_before_steps')
    expect(view.outcome).toBe('cancelled')
    expect(view.stepOrder).toEqual([])
    expect(view.text).toBe('')
  })

  it('stop_during_steps: cancelled with rows and no text', () => {
    const { view } = play('stop_during_steps')
    expect(view.outcome).toBe('cancelled')
    expect(view.stepOrder.length).toBeGreaterThan(0)
    expect(view.text).toBe('')
  })

  it('cancelled: the answer keeps the text sent before Stop, marked stopped', () => {
    const { view, messages } = play('cancelled')
    expect(view.outcome).toBe('cancelled')
    expect(messages[1]).toMatchObject({ stopped: true })
    expect(messages[1]!.content.length).toBeGreaterThan(0)
  })

  it('job_admission_rejected: no answer row', () => {
    const { messages } = play('job_admission_rejected')
    expect(messages.map((m) => m.id)).toEqual([TURN])
  })

  it('hitl_choice: the prompt opens, and the answer follows its resolution', () => {
    const { view, messages } = play('hitl_choice')
    expect(view.interaction).toBeUndefined()
    expect(messages.some((m) => m.messageType === 'prompt' && m.promptInputType === 'choice')).toBe(
      true
    )
    expect(messages.at(-1)).toMatchObject({ id: ANSWER_ID })
  })

  it('hitl_plan: the plan prompt, then the run', () => {
    const { messages } = play('hitl_plan')
    expect(messages.find((m) => m.messageType === 'prompt')?.content).toMatch(/plan_json/)
    expect(messages.some((m) => m.id === RUN.run_message_id)).toBe(true)
  })

  it('proposal_accept: the answer carries the proposal card', () => {
    const { messages } = play('proposal_accept')
    expect(messages[1]!.cards?.[0]).toMatchObject({
      type: 'file_operation_proposal',
      operation: 'create_folder',
    })
  })
})
