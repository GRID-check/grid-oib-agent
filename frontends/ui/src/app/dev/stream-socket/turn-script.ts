/**
 * The frames a v2 backend sends for one `oib2` turn, as `/dev/stream-socket`
 * plays them through a stubbed `WebSocket`.
 *
 * The turn is `_fixtures/v2-turn.ts`: `RUN_STARTED`, the setup and retrieval
 * steps modelled on `shared/wire/v2/turn-answered.jsonl`, the recorded `oib2`
 * answer mapped onto v2 events, the heartbeats and a stage. Every frame is one
 * typed fact, so no frame's size depends on the prompt; the old `heavy` mode,
 * NAT's step adaptor with the prompt in every token frame, has no v2 form.
 *
 * Frames are JSON strings built once, before the turn, with two placeholders
 * the fake server fills at send time: the conversation id, and the turn id (the
 * `message_id` of the question the composer sent). `ts` is stamped at send.
 */

import { STREAM_FRAMES } from '../_fixtures/stream-frames'
import { v2Turn } from '../_fixtures/v2-turn'

export const TURN_PLACEHOLDER = '__STREAM_SOCKET_TURN__'
export const CONVERSATION_PLACEHOLDER = '__STREAM_SOCKET_CONVERSATION__'

export type FrameKind = 'step' | 'delta' | 'response' | 'snapshot' | 'terminal' | 'heartbeat'

export interface ScriptFrame {
  /** Milliseconds after the user message reached the server. */
  at: number
  kind: FrameKind
  data: string
}

export interface TurnScript {
  question: string
  frames: ScriptFrame[]
  /** Bytes of step frames, for the probe: what the client had to parse before the answer. */
  stepBytes: number
  /** The largest frame other than the settled snapshot and the terminal (the design's bound is 4 KB). */
  maxFrameBytes: number
  totalBytes: number
}

const kindOf = (frame: Record<string, unknown>): FrameKind => {
  if (frame.type === 'STEP_STARTED' || frame.type === 'STEP_FINISHED') return 'step'
  if (frame.type === 'TEXT_MESSAGE_CONTENT') return 'delta'
  if (frame.type === 'RUN_FINISHED') return 'terminal'
  // The settled answer carries its verified sources, once per turn (design DoD 4).
  if (frame.type === 'STATE_SNAPSHOT') return 'snapshot'
  if (frame.name === 'heartbeat') return 'heartbeat'
  return 'response'
}

export const buildTurnScript = (speed: number): TurnScript => {
  const ids = { conversationId: CONVERSATION_PLACEHOLDER, turnId: TURN_PLACEHOLDER, messageId: 'stream-socket-answer' }
  const frames = v2Turn(STREAM_FRAMES.oib2, ids, speed).map(({ at, frame }) => ({
    at,
    kind: kindOf(frame),
    data: JSON.stringify(frame),
  }))
  const encoder = new TextEncoder()
  const bytes = (kinds: FrameKind[]) =>
    frames.filter((f) => kinds.includes(f.kind)).map((f) => encoder.encode(f.data).length)
  return {
    question: STREAM_FRAMES.oib2.question,
    frames,
    stepBytes: bytes(['step']).reduce((sum, n) => sum + n, 0),
    maxFrameBytes: Math.max(0, ...bytes(['step', 'delta', 'response', 'heartbeat'])),
    totalBytes: bytes(['step', 'delta', 'response', 'snapshot', 'heartbeat', 'terminal']).reduce((sum, n) => sum + n, 0),
  }
}
