/**
 * The shapes a turn takes besides the happy path, built from the
 * same recording (`./v2-turn.ts`), for `/dev/stream-socket?scenario=`.
 *
 * Each one exists because a lifecycle of the streaming answer had no fixture
 * that could show it (lifecycle audit, 2026-10): an answer that is only cards,
 * a masthead that waits on screen before the first word, a turn with no steps,
 * an answer that opens with a table or a card, a single line, many screens, a
 * second question right after the first settles, and a card the retraction
 * takes back. `?error=` overlays a `RUN_ERROR` at one phase on any of them.
 *
 * Every scenario but `rewrite` ends the way the product ends a turn today
 * (`asSettled`): the terminal continues the settle. `rewrite` keeps the
 * recorded ending, the retired whole-answer repair, to exercise a terminal
 * that does not continue what was shown.
 *
 * The prose is the recorded prose wherever the shape allows: synthesised text
 * is only what the shape itself needs (the table rows, the one line). Bodies
 * only; `stampTurn` makes them a turn.
 */

import { CARD_PREVIEW_FIXTURES } from '@/features/grid-cards/preview-fixtures'
import type { RecordedTurn } from './stream-frames'
import { answerBodies, asSettled, keyed, stampTurn, stepBodies, type TimedBody, type TimedFrame } from './v2-turn'

export const STREAM_SCENARIOS = [
  'happy',
  'cards-only',
  'masthead-first',
  'shallow',
  'opens-table',
  'opens-card',
  'one-line',
  'long',
  'two-turns',
  'retract-with-card',
  'rewrite',
] as const
export type StreamScenario = (typeof STREAM_SCENARIOS)[number]

/**
 * Where `?error=` ends the turn with a `RUN_ERROR`:
 *
 * - `preack`: before the first step, the setup failing. `RUN_STARTED` is the
 *   ack and goes out before any setup I/O (`websocket-protocol.md`), so a
 *   failure can come no earlier than right after it; a question that is never
 *   acknowledged at all is `/dev/turn-outcomes?scenario=error_preack`.
 * - `steps`: after the first retrieval round's sources, mid-Herleitung.
 * - `prose`: half way through the answer's deltas.
 * - `finish`: where `RUN_FINISHED` would have been, after the settle.
 */
export const ERROR_PHASES = ['preack', 'steps', 'prose', 'finish'] as const
export type ErrorPhase = (typeof ERROR_PHASES)[number]

export const isStreamScenario = (value: string | null): value is StreamScenario =>
  STREAM_SCENARIOS.includes(value as StreamScenario)
export const isErrorPhase = (value: string | null): value is ErrorPhase => ERROR_PHASES.includes(value as ErrorPhase)

type Ids = { conversationId: string; turnId: string; messageId: string }

/** Two cards an answer can carry, as the gallery validated them. */
const CARDS = [CARD_PREVIEW_FIXTURES.egress_diagram, CARD_PREVIEW_FIXTURES.calculation].filter(Boolean)

const cardBody = (at: number, index: number): TimedBody => {
  const [{ key, card }] = keyed([CARDS[index % CARDS.length]])
  return { at, body: { type: 'CUSTOM', name: 'card', value: { index, key, card } } }
}

const isDelta = ({ body }: TimedBody) => body.type === 'TEXT_MESSAGE_CONTENT'
const textOf = (bodies: readonly TimedBody[]) => bodies.filter(isDelta).map(({ body }) => String(body.delta)).join('')

/** Every body from `at` on, `by` ms later. */
const shift = (bodies: readonly TimedBody[], by: number): TimedBody[] => bodies.map(({ at, body }) => ({ at: at + by, body }))

/**
 * The recorded answer with its streamed prose replaced: `deltas` between the
 * recorded START and END, and the settle and the terminal carrying `text`
 * (what was streamed), so the turn folds to exactly the prose it showed. The
 * recorded settle and terminal keep their distance from the last delta.
 */
const withProse = (answer: readonly TimedBody[], deltas: readonly TimedBody[], messageId: string): TimedBody[] => {
  const recorded = answer.filter(isDelta)
  const lastRecorded = recorded.at(-1)?.at ?? 0
  const lastNew = deltas.at(-1)?.at ?? lastRecorded
  const text = textOf(deltas)
  const head = answer.filter(({ body, at }) => at <= (recorded[0]?.at ?? 0) && !isDelta({ at, body }))
  const tail = shift(
    answer.filter(({ at, body }) => at > lastRecorded && !isDelta({ at, body })),
    lastNew - lastRecorded
  ).map(({ at, body }) => ({ at, body: retext(body, text, messageId) }))
  return [...head, ...deltas, ...tail]
}

/** The settle and the terminal, with `text` in place of the recorded text. */
const retext = (body: Record<string, unknown>, text: string, messageId: string): Record<string, unknown> => {
  if (body.type === 'STATE_SNAPSHOT') return { ...body, snapshot: { ...(body.snapshot as object), text } }
  if (body.type === 'RUN_FINISHED') return { ...body, result: { ...(body.result as object), message_id: messageId, text } }
  return body
}

const delta = (at: number, text: string, messageId: string): TimedBody => ({
  at,
  body: { type: 'TEXT_MESSAGE_CONTENT', message_id: messageId, delta: text },
})

/** `text` as deltas of a few words, one every `every` ms from `start`. */
const chunked = (text: string, start: number, messageId: string, every = 90): TimedBody[] =>
  (text.match(/(?:\S+\s*){1,4}|\s+/g) ?? []).map((chunk, index) => delta(start + index * every, chunk, messageId))

const TABLE = [
  '| Nachweis | Anforderung | Fundstelle |',
  '|---|---|---|',
  '| Tragende Bauteile | R 60 | Tabelle 1b |',
  '| Trennwände | REI 60 | Tabelle 1b |',
  '| Treppenhauswände | REI 90 | Pkt. 5.1 |',
  '| Fluchtweglänge | ≤ 40 m | Pkt. 5.1.1 |',
]

const ONE_LINE = 'Ja, die OIB-Richtlinie 2 gilt für alle Gebäudeklassen.'

/** The body of each scenario, between `RUN_STARTED` and the terminal. */
const scenarioBodies = (name: StreamScenario, turn: RecordedTurn, messageId: string, speed: number): TimedBody[] => {
  const { bodies: steps, answerStart } = stepBodies()
  const recorded = answerBodies(turn, messageId, answerStart, speed)
  const answer = asSettled(recorded)
  const deltas = answer.filter(isDelta)
  const firstDelta = deltas[0]?.at ?? answerStart
  switch (name) {
    case 'happy':
    case 'two-turns':
      return [...steps, ...answer]
    case 'cards-only': {
      // No prose at all: the cards are the answer, and the terminal's text is empty.
      const finished = answer.find(({ body }) => body.type === 'RUN_FINISHED')!
      const result = {
        ...(finished.body.result as object),
        message_id: messageId,
        text: '',
        sources: [],
        answer_meta: undefined,
        cards: keyed(CARDS),
      }
      return [
        ...steps,
        cardBody(answerStart, 0),
        cardBody(answerStart + 700, 1),
        { at: answerStart + 1_600, body: { type: 'RUN_FINISHED', outcome: 'answered', result } },
      ]
    }
    case 'masthead-first': {
      // The masthead lands, then nothing for 1.5 s: the reader looks at it alone.
      const masthead = answer.filter(({ body }) => body.name === 'masthead')
      const rest = answer.filter(({ body }) => body.name !== 'masthead')
      return [...steps, ...masthead.map(({ body }) => ({ at: answerStart, body })), ...shift(rest, 1_500)]
    }
    case 'shallow':
      // A direct answer: no documents, no retrieval, no synthesis row.
      return asSettled(answerBodies(turn, messageId, 600, speed))
    case 'opens-table': {
      // The answer's first block is a table, streamed a row at a time in two halves.
      const rows = TABLE.flatMap((row) => {
        const middle = row.indexOf('|', Math.floor(row.length / 2))
        return middle > 0 ? [row.slice(0, middle), `${row.slice(middle)}\n`] : [`${row}\n`]
      })
      const table = rows.map((chunk, index) => delta(firstDelta + index * 120, chunk, messageId))
      const after = (table.at(-1)?.at ?? firstDelta) + 120
      const prose = [delta(after, '\n', messageId), ...shift(deltas, after + 60 - firstDelta)]
      return [...steps, ...withProse(answer, [...table, ...prose], messageId)]
    }
    case 'opens-card': {
      // The card arrives first, and the prose opens on its placement marker.
      const card = cardBody(firstDelta - 200, 0)
      const prose = [delta(firstDelta, '[[card:1]]\n\n', messageId), ...shift(deltas, 80)]
      return [...steps, card, ...withProse(answer, prose, messageId).map((b) => withCards(b, 1))]
    }
    case 'one-line':
      return [...steps, ...withProse(answer, [delta(firstDelta, ONE_LINE, messageId)], messageId)]
    case 'long': {
      // The recorded prose six times over: many screens of reading.
      const span = (deltas.at(-1)?.at ?? firstDelta) - firstDelta + 400
      const copies = Array.from({ length: 6 }, (_, copy) => [
        ...(copy > 0 ? [delta(firstDelta + copy * span - 100, '\n\n', messageId)] : []),
        ...shift(deltas, copy * span),
      ]).flat()
      return [...steps, ...withProse(answer, copies, messageId)]
    }
    case 'retract-with-card': {
      // A preamble and its card stream, the model calls another tool, both are
      // retracted, and the real answer follows.
      const preamble = chunked('Ich prüfe dazu die Gehweglänge im Erdgeschoß:\n\n[[card:1]]', firstDelta, messageId)
      const preambleEnd = preamble.at(-1)!.at
      const retractAt = preambleEnd + 2_500
      return [
        ...steps,
        { at: firstDelta, body: { type: 'TEXT_MESSAGE_START', message_id: messageId } },
        ...preamble,
        cardBody(preambleEnd + 300, 0),
        { at: preambleEnd + 400, body: { type: 'TEXT_MESSAGE_END', message_id: messageId } },
        { at: retractAt, body: { type: 'CUSTOM', name: 'answer_retracted', value: {} } },
        ...shift(answer, retractAt + 1_200 - answerStart),
      ]
    }
    case 'rewrite':
      // The retired whole-answer repair (ADR-0067): the terminal replaces the
      // settled answer with other text and sources. Kept to exercise a
      // non-continuing terminal; no current backend sends one.
      return [...steps, ...recorded]
  }
}

/** The terminal of an answer that placed `count` cards carries them. */
const withCards = (timed: TimedBody, count: number): TimedBody => {
  if (timed.body.type !== 'RUN_FINISHED') return timed
  const result = { ...(timed.body.result as object), cards: keyed(CARDS.slice(0, count)) }
  return { at: timed.at, body: { ...timed.body, result } }
}

/** The bodies cut at `phase`, ended by a `RUN_ERROR`; nothing after it is sent. */
export const failAt = (bodies: readonly TimedBody[], phase: ErrorPhase): TimedBody[] => {
  const sorted = [...bodies].sort((a, b) => a.at - b.at)
  const deltas = sorted.filter(isDelta)
  const firstSources = sorted.find(({ body }) => (body.step as { kind?: string } | undefined)?.kind === 'sources')
  const finishAt = sorted.find(({ body }) => body.type === 'RUN_FINISHED')?.at ?? sorted.at(-1)?.at ?? 0
  // The last moment whose bodies still go out; the error follows a millisecond later.
  const lastSent = {
    preack: -1,
    steps: firstSources?.at ?? -1,
    prose: deltas[Math.floor(deltas.length / 2)]?.at ?? finishAt,
    finish: finishAt,
  }[phase]
  const kept = sorted.filter(({ at, body }) => at <= lastSent && body.type !== 'RUN_FINISHED')
  const error = {
    type: 'RUN_ERROR',
    code: 'workflow_error',
    message: 'The model provider closed the connection.',
    details: null,
  }
  return [...kept, { at: phase === 'preack' ? 300 : lastSent + 1, body: error }]
}

/** One scenario's turn, stamped and numbered, optionally failing at `error`. */
export const v2Scenario = (
  name: StreamScenario,
  turn: RecordedTurn,
  ids: Ids,
  speed = 1,
  error?: ErrorPhase
): TimedFrame[] => {
  const bodies = scenarioBodies(name, turn, ids.messageId, speed)
  return stampTurn(error ? failAt(bodies, error) : bodies, ids)
}
