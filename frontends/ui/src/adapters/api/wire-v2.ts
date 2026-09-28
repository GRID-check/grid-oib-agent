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

import type { z } from 'zod'
import { clientMessageSchema, helloSchema, wireEventSchema } from './wire-v2.generated'

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

/** Every server-to-client event, after parsing (defaults applied). */
export type WireEvent = z.infer<typeof wireEventSchema>
/** The server's first frame on a socket: it speaks this wire. A connection frame, not a turn's. */
export type Hello = z.infer<typeof helloSchema>
/** Every client-to-server message, as the client builds it. */
export type ClientMessage = z.input<typeof clientMessageSchema>

export type WireEventType = WireEvent['type']
export type CustomEvent = Extract<WireEvent, { type: 'CUSTOM' }>
export type CustomEventName = CustomEvent['name']
export type StepEvent = Extract<WireEvent, { type: 'STEP_STARTED' | 'STEP_FINISHED' }>
export type Step = StepEvent['step']
export type StepKind = Step['kind']
export type TurnResult = Extract<WireEvent, { type: 'RUN_FINISHED' }>['result']

/**
 * One frame off the socket, or `null` when it is not a v2 event.
 *
 * A frame the contract does not describe never reaches the fold. What `null`
 * means is the caller's: the chat socket takes it for a server newer than this
 * bundle and asks for a reload (`turn-socket.ts`), a spectator relay drops it.
 * There is no second reader: an old frame shape is not a v2 event.
 */
export const parseWireEvent = (raw: unknown): WireEvent | null => {
  const parsed = wireEventSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * The socket's first frame, or `null` when it is anything else: a server that
 * opens with something other than a v2 hello does not speak this wire.
 */
export const parseHello = (raw: unknown): Hello | null => {
  const parsed = helloSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
