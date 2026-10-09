/**
 * The chat wire, version 2: what the socket carries, typed (ADR-0068).
 *
 * The schemas are GENERATED: `src/aiq_agent/common/wire_v2.py` (Pydantic) is the
 * source, `shared/wire/v2.schema.json` its JSON Schema, and
 * `./wire-v2.generated.ts` the Zod module `npm run generate:wire` renders from
 * it. This file adds only what a generator cannot: the inferred types under
 * readable names, and the one parse function every reader uses (the live
 * socket, the replay after a reconnect, the spectator relay). Nothing here
 * restates a field.
 *
 * Design of record: `docs/design/chat-wire-v2.md`.
 */

import { z } from 'zod'
import {
  clientMessageSchema,
  heartbeatSchema,
  helloSchema,
  shownAnswerSchema,
  stepStartedSchema,
  wireEventSchema,
} from './wire-v2.generated'

export {
  answerSnapshotSchema,
  clientMessageSchema,
  helloSchema,
  keyedCardSchema,
  traceLaneSchema,
  turnResultSchema,
  wireEventSchema,
} from './wire-v2.generated'

/** The only wire version. A socket that asks for another is closed with {@link CLOSE_CLIENT_OUTDATED}. */
export const WIRE_VERSION = 2

/** Close code: this page runs an older bundle than the server speaks. The client asks the reader to reload. */
export const CLOSE_CLIENT_OUTDATED = 4426

/**
 * A turn event from a server newer than this bundle, as {@link parseWireEvent}
 * hands it on: a `type`, a step `kind` or a `CUSTOM` name this bundle does not
 * know. Its envelope is kept, so the fold advances `seq` past it and the turn
 * stays continuous; its body is dropped, so nothing reads it. `of` says what it
 * was: `NEW_TYPE`, `STEP_FINISHED:<kind>` or `CUSTOM:<name>`.
 */
export type UnknownWireEvent = z.infer<typeof unknownEnvelopeSchema> & {
  type: 'UNKNOWN'
  of: string
}

/** Every server-to-client event, after parsing (defaults applied). */
export type WireEvent = z.infer<typeof wireEventSchema> | UnknownWireEvent
/** The server's first frame on a socket: it speaks this wire. A connection frame, not a turn's. */
export type Hello = z.infer<typeof helloSchema>
/** Every client-to-server message, as the client builds it. */
export type ClientMessage = z.input<typeof clientMessageSchema>
/** How much of the answer the asker had on screen when they pressed Stop (`cancel_turn.shown`). */
export type ShownAnswer = z.input<typeof shownAnswerSchema>

export type WireEventType = WireEvent['type']
export type CustomEvent = Extract<WireEvent, { type: 'CUSTOM' }>
export type CustomEventName = CustomEvent['name']
export type StepEvent = Extract<WireEvent, { type: 'STEP_STARTED' | 'STEP_FINISHED' }>
export type Step = StepEvent['step']
export type StepKind = Step['kind']
export type TurnResult = Extract<WireEvent, { type: 'RUN_FINISHED' }>['result']

const [byType, byName] = wireEventSchema.options
const KNOWN_TYPES: ReadonlySet<unknown> = new Set([...byType.optionsMap.keys(), 'CUSTOM'])
const KNOWN_CUSTOM_NAMES: ReadonlySet<unknown> = new Set(byName.optionsMap.keys())
const KNOWN_STEP_KINDS: ReadonlySet<unknown> = new Set(
  stepStartedSchema.shape.step.optionsMap.keys()
)

/**
 * The envelope every turn event carries, taken from the generated heartbeat
 * minus its defaults: a frame must say it is v2 and name its `type`, or it is
 * not a v2 event. A frame with no `turn_id` (the hello) is not a turn's event.
 */
const unknownEnvelopeSchema = heartbeatSchema
  .omit({ name: true, value: true, type: true })
  .extend({ v: z.literal(2) })

/** What a frame is, if it names something this bundle does not know; `null` if it names only known things. */
const unknownPart = (raw: Record<string, unknown>): string | null => {
  const { type } = raw
  if (typeof type !== 'string') return null
  if (!KNOWN_TYPES.has(type)) return type
  if (type === 'CUSTOM') {
    return typeof raw.name === 'string' && !KNOWN_CUSTOM_NAMES.has(raw.name)
      ? `CUSTOM:${raw.name}`
      : null
  }
  if (type !== 'STEP_STARTED' && type !== 'STEP_FINISHED') return null
  const kind = (raw.step as { kind?: unknown } | null | undefined)?.kind
  return typeof kind === 'string' && !KNOWN_STEP_KINDS.has(kind) ? `${type}:${kind}` : null
}

/**
 * One frame off the socket, or `null` when it is not a v2 event this bundle
 * can read.
 *
 * Additive drift from a newer server is read, not refused, because a tab
 * outlives a deploy (`docs/design/chat-wire-v2.md` §a, "Compatibility"): an
 * unknown key is stripped (the generated server-to-client schemas are not
 * strict), and a v2 turn event of an unknown `type`, step `kind` or `CUSTOM`
 * name comes back as {@link UnknownWireEvent}, which the fold passes over. A
 * frame that names only known things and still does not parse (a field
 * renamed or retyped) is `null`, and what that means is the caller's: the chat
 * socket takes it for a server newer than this bundle and asks for a reload
 * (`turn-socket.ts`), a spectator relay drops it. There is no second reader:
 * an old frame shape is not a v2 event.
 */
export const parseWireEvent = (raw: unknown): WireEvent | null => {
  const parsed = wireEventSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  if (!raw || typeof raw !== 'object') return null
  const of = unknownPart(raw as Record<string, unknown>)
  const envelope = of === null ? null : unknownEnvelopeSchema.safeParse(raw)
  return of !== null && envelope?.success ? { ...envelope.data, type: 'UNKNOWN', of } : null
}

/**
 * The socket's first frame, or `null` when it is anything else: a server that
 * opens with something other than a v2 hello does not speak this wire.
 */
export const parseHello = (raw: unknown): Hello | null => {
  const parsed = helloSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
