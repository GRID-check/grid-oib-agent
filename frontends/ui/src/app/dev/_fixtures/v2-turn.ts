/**
 * A recorded answer (`./stream-frames.ts`) as chat wire v2 events, for the dev
 * pages that replay one: `/dev/stream-replay` folds them directly,
 * `/dev/stream-socket` sends them through a fake socket.
 *
 * The recording predates v2, so its chunks are mapped once, here, onto the
 * events the v2 producers write for the same moments (`docs/design/chat-wire-v2.md`
 * §a): a masthead-only chunk is `masthead`, prose is `TEXT_MESSAGE_*`, the
 * settle is `STATE_SNAPSHOT`, each card is a `card` event, and the terminal is
 * `RUN_FINISHED` with its result. The steps before the answer follow
 * `shared/wire/v2/turn-answered.jsonl`, one retrieval round per query.
 */

import type { RecordedFrame, RecordedTurn } from './stream-frames'

/** One event body (no envelope) and when it is sent, in ms after the question. */
export interface TimedBody {
  at: number
  body: Record<string, unknown>
}

/** The envelope-stamped frames, in order, with their seq. */
export interface TimedFrame {
  at: number
  frame: Record<string, unknown>
}

/** A stand-in for the backend's `card_key` (a hash of the card's JSON): equal cards, equal keys. */
const cardKey = (card: unknown): string => {
  let hash = 0x811c9dc5
  for (const char of JSON.stringify(card)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}

const keyed = (cards: readonly unknown[] = []) => cards.map((card) => ({ key: cardKey(card), card }))

/** The fields of a recorded terminal that `TurnResult` carries. */
const RESULT_FIELDS = [
  'sources',
  'answer_meta',
  'answer_confidence',
  'answer_confidence_reason',
  'routing_decision',
  'read_sources',
  'retrieval_ledger',
  'skills_activated',
] as const

const resultOf = (frame: RecordedFrame, messageId: string): Record<string, unknown> => ({
  message_id: messageId,
  text: frame.content,
  cards: keyed(frame.cards),
  ...Object.fromEntries(RESULT_FIELDS.filter((field) => frame[field] != null).map((field) => [field, frame[field]])),
})

/** The recorded answer, from its first chunk, `speed` times its recorded pace, starting at `start` ms. */
export const answerBodies = (turn: RecordedTurn, messageId: string, start = 0, speed = 1): TimedBody[] => {
  const t0 = turn.frames[0]?.t ?? 0
  const out: TimedBody[] = []
  let streaming = false
  for (const frame of turn.frames) {
    const at = start + Math.round(((frame.t - t0) * 1000) / speed)
    const push = (body: Record<string, unknown>) => out.push({ at, body })
    if (frame.status === 'complete') {
      if (streaming) push({ type: 'TEXT_MESSAGE_END', message_id: messageId })
      push({ type: 'RUN_FINISHED', outcome: 'answered', result: resultOf(frame, messageId) })
      continue
    }
    if (frame.stream_replace) {
      const meta = frame.answer_meta ? { answer_meta: frame.answer_meta } : {}
      push({ type: 'STATE_SNAPSHOT', snapshot: { text: frame.content, sources: frame.sources ?? [], ...meta } })
    } else if (frame.content) {
      if (!streaming) push({ type: 'TEXT_MESSAGE_START', message_id: messageId })
      streaming = true
      push({ type: 'TEXT_MESSAGE_CONTENT', message_id: messageId, delta: frame.content })
    } else if (frame.answer_meta) {
      push({ type: 'CUSTOM', name: 'masthead', value: { answer_meta: frame.answer_meta } })
    }
    keyed(frame.cards).forEach(({ key, card }, index) =>
      push({ type: 'CUSTOM', name: 'card', value: { index, key, card } })
    )
  }
  return out
}

const QUERIES = ['OIB-Richtlinie 2 Geltungsbereich', 'OIB-RL 2 Ausgabe 2023 Abweichungen Landesrecht', 'Brandschutz Fluchtwege Gebäudeklassen']
/** `TURN_HEARTBEAT_SECONDS`, as the handler beats while a turn runs. */
export const HEARTBEAT_MS = 20_000
/** Milliseconds one retrieval round takes, model call and search together. */
const ROUND_MS = 4_000

/** One knowledge search's fan-out, as `render_grounding_block` builds it. */
const lanes = (round: number) => [
  {
    key: 'baurecht_oib',
    label: 'OIB-Richtlinie',
    kind: 'baurecht',
    hit_count: 6,
    sources: [
      { name: 'oib-rl_2_ausgabe_mai_2023.pdf', title: 'OIB-Richtlinie 2, Ausgabe Mai 2023', detail: `p.${4 + round}`, shelf: 'base', round },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `oib-rl_2_erlaeuterungen_${i + 1}.pdf`, detail: `p.${10 + i}`, shelf: 'base', round })),
    ],
  },
  {
    key: 'projekt',
    label: 'Projektwissen',
    kind: 'projekt',
    hit_count: 3,
    sources: Array.from({ length: 3 }, (_, i) => ({ name: `Brandschutzkonzept_Stiege_${i + 1}.pdf`, detail: `p.${3 + i}`, shelf: 'project', round })),
  },
]

/** The steps before the answer: documents, three retrieval rounds, synthesis. Returns the bodies and when the answer may start. */
const stepBodies = (): { bodies: TimedBody[]; answerStart: number } => {
  const bodies: TimedBody[] = [
    { at: 40, body: { type: 'STEP_FINISHED', step: { id: 'status:documents', kind: 'status', slot: 'documents', key: 'status.documents.project' } } },
  ]
  QUERIES.forEach((query, round) => {
    const at = 200 + round * ROUND_MS
    const tool = { id: `tool:call_${round}`, kind: 'tool', tool: 'knowledge_search' }
    bodies.push(
      { at, body: { type: 'STEP_FINISHED', step: { id: `status:retrieval:${round}`, kind: 'retrieval', round, key: 'status.retrieval.withQuery', values: { corpus: 'knowledge', query }, tools: ['knowledge_search'] } } },
      { at: at + 2_000, body: { type: 'STEP_STARTED', step: tool } },
      { at: at + 3_400, body: { type: 'STEP_FINISHED', step: { id: `sources:${round}:knowledge_search:1`, kind: 'sources', round, tool: 'knowledge_search', lanes: lanes(round) } } },
      { at: at + 3_405, body: { type: 'STEP_FINISHED', step: { ...tool, status: 'ok' } } }
    )
  })
  const synthesis = 200 + QUERIES.length * ROUND_MS
  bodies.push({ at: synthesis, body: { type: 'STEP_FINISHED', step: { id: 'status:synthesis', kind: 'status', slot: 'synthesis', key: 'status.synthesis' } } })
  return { bodies, answerStart: synthesis + 300 }
}

/** The whole turn: RUN_STARTED, the steps, the recorded answer, the heartbeats, a stage. Stamped and numbered. */
export const v2Turn = (
  turn: RecordedTurn,
  ids: { conversationId: string; turnId: string; messageId: string },
  speed = 1
): TimedFrame[] => {
  const { bodies, answerStart } = stepBodies()
  const answer = answerBodies(turn, ids.messageId, answerStart, speed)
  const end = answer.at(-1)?.at ?? answerStart
  const all: TimedBody[] = [
    { at: 0, body: { type: 'RUN_STARTED', message_id: ids.messageId } },
    ...bodies,
    ...answer,
    { at: end + 900, body: { type: 'CUSTOM', name: 'stage', value: { stage: 'memory_reflection', status: 'empty' } } },
  ]
  // The heartbeat is stamped by the same sequencer, so it takes its place in seq.
  for (let at = HEARTBEAT_MS; at < end; at += HEARTBEAT_MS) {
    all.push({ at, body: { type: 'CUSTOM', name: 'heartbeat', value: { every_ms: HEARTBEAT_MS } } })
  }
  all.sort((a, b) => a.at - b.at)
  return all.map(({ at, body }, index) => ({ at, frame: stampFrame(index + 1, body, ids) }))
}

/** The v2 envelope around a body. `ts` is left to the sender, which knows the clock. */
export const stampFrame = (
  seq: number,
  body: Record<string, unknown>,
  ids: { conversationId: string; turnId: string }
): Record<string, unknown> => ({ v: 2, conversation_id: ids.conversationId, turn_id: ids.turnId, seq, ts: 0, ...body })
