/**
 * The frames a v2 backend sends for one `oib2` turn, as `/dev/stream-socket`
 * plays them through a stubbed `WebSocket`.
 *
 * The turn is `_fixtures/v2-turn.ts`: `RUN_STARTED`, the setup and retrieval
 * steps modelled on `shared/wire/v2/turn-answered.jsonl`, the recorded `oib2`
 * answer mapped onto v2 events, the heartbeats and a stage. Its terminal
 * continues the settle, as the product's does today (`asSettled`); the
 * recording's own terminal, the retired whole-answer rewrite, is
 * `?scenario=rewrite`. Every frame is one
 * typed fact, so no frame's size depends on the prompt; the old `heavy` mode,
 * NAT's step adaptor with the prompt in every token frame, has no v2 form.
 *
 * `?scenario=` picks another shape of the same recording
 * (`_fixtures/v2-scenarios.ts`), and `?error=` ends it with a `RUN_ERROR` at
 * one phase. `two-turns` scripts a second question, the `varianten` recording,
 * which the page sends once the first answer has settled.
 *
 * Frames are JSON strings built once, before the turn, with two placeholders
 * the fake server fills at send time: the conversation id, and the turn id (the
 * `message_id` of the question the composer sent). `ts` is stamped at send.
 */

import { STREAM_FRAMES } from '../_fixtures/stream-frames'
import { v2Scenario, type ErrorPhase, type StreamScenario } from '../_fixtures/v2-scenarios'

export const TURN_PLACEHOLDER = '__STREAM_SOCKET_TURN__'
export const CONVERSATION_PLACEHOLDER = '__STREAM_SOCKET_CONVERSATION__'
/** The answer's message id: the probe finds the answer card by it (`#message-<id>`). */
export const ANSWER_MESSAGE_ID = 'stream-socket-answer'
/** The answer id of the scripted turn at `index` (the first keeps the id the probe and the measure script know). */
export const answerMessageId = (index: number): string => (index === 0 ? ANSWER_MESSAGE_ID : `${ANSWER_MESSAGE_ID}-${index + 1}`)

export type FrameKind = 'step' | 'delta' | 'response' | 'snapshot' | 'terminal' | 'heartbeat'

export interface ScriptFrame {
  /** Milliseconds after the user message reached the server. */
  at: number
  kind: FrameKind
  data: string
}

/** One question and the frames that answer it. */
export interface ScriptTurn {
  question: string
  frames: ScriptFrame[]
}

export interface TurnScript {
  /** The first turn's question and frames: the one every scenario has. */
  question: string
  frames: ScriptFrame[]
  /** Every scripted turn, the first included, in the order the page asks them. */
  turns: ScriptTurn[]
  /** Bytes of step frames, for the probe: what the client had to parse before the answer. */
  stepBytes: number
  /** The largest frame other than the settled snapshot and the terminal (the design's bound is 4 KB). */
  maxFrameBytes: number
  totalBytes: number
}

const kindOf = (frame: Record<string, unknown>): FrameKind => {
  if (frame.type === 'STEP_STARTED' || frame.type === 'STEP_FINISHED') return 'step'
  if (frame.type === 'TEXT_MESSAGE_CONTENT') return 'delta'
  if (frame.type === 'RUN_FINISHED' || frame.type === 'RUN_ERROR') return 'terminal'
  // The settled answer carries its verified sources, once per turn (design DoD 4).
  if (frame.type === 'STATE_SNAPSHOT') return 'snapshot'
  if (frame.name === 'heartbeat') return 'heartbeat'
  return 'response'
}

export interface ScriptOptions {
  scenario?: StreamScenario
  error?: ErrorPhase
}

export const buildTurnScript = (speed: number, { scenario = 'happy', error }: ScriptOptions = {}): TurnScript => {
  const recordings = scenario === 'two-turns' ? [STREAM_FRAMES.oib2, STREAM_FRAMES.varianten] : [STREAM_FRAMES.oib2]
  const turns = recordings.map((recording, index) => {
    const ids = { conversationId: CONVERSATION_PLACEHOLDER, turnId: TURN_PLACEHOLDER, messageId: answerMessageId(index) }
    // `?error=` fails the first turn: the second question is never asked after a failure.
    const frames = v2Scenario(scenario, recording, ids, speed, index === 0 ? error : undefined).map(({ at, frame }) => ({
      at,
      kind: kindOf(frame),
      data: JSON.stringify(frame),
    }))
    return { question: recording.question, frames }
  })
  const encoder = new TextEncoder()
  const all = turns.flatMap((turn) => turn.frames)
  const bytes = (kinds: FrameKind[]) => all.filter((f) => kinds.includes(f.kind)).map((f) => encoder.encode(f.data).length)
  return {
    question: turns[0].question,
    frames: turns[0].frames,
    turns,
    stepBytes: bytes(['step']).reduce((sum, n) => sum + n, 0),
    maxFrameBytes: Math.max(0, ...bytes(['step', 'delta', 'response', 'heartbeat'])),
    totalBytes: bytes(['step', 'delta', 'response', 'snapshot', 'heartbeat', 'terminal']).reduce((sum, n) => sum + n, 0),
  }
}
