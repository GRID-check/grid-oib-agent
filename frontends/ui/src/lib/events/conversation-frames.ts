/**
 * Subscribe to the agent's outbound frames for ONE conversation, so a colleague
 * can watch a turn happen instead of waiting for it to finish.
 *
 * ## What this reads, and why nothing new had to be built to produce it
 *
 * The Python tier already publishes every outbound WebSocket frame to
 * `conv:<id>:events` on Dragonfly — that is the conversation bus
 * (`frontends/aiq_api/src/aiq_api/conversation_bus.py`, ADR-0028), whose day job
 * is letting the replica that holds a socket relay frames for a turn owned by a
 * different replica. An observer of a shared thread wants exactly the same bytes
 * for exactly the same reason: they do not hold the socket either. So this
 * subscribes as one more relay rather than adding a second streaming path that
 * would have to be kept in step with the first.
 *
 * The envelope shape (`{v, conv, seq, origin, type, payload}`) is that module's
 * wire contract, and `docs/architecture/backend-deep-dive.md` documents it.
 * Anything unrecognised is dropped rather than guessed at.
 *
 * ## Why this is a separate module from `./bus`
 *
 * `./bus` owns per-USER channels, where the authorization argument is "a
 * subscriber only ever receives what the server addressed to them". That
 * argument does not transfer: this subscribes to a per-RESOURCE channel, so
 * authorization has to happen at subscribe time and stay true for as long as the
 * subscription lives. `GET /api/conversations/:id/live` is the only caller and
 * carries that burden explicitly (it re-checks, and it closes on revocation).
 * Keeping the two transports in separate files keeps the two arguments from being
 * confused for one another.
 *
 * ## Degradation
 *
 * With no `REDIS_URL` there is no cross-process channel to read — the backend's
 * bus falls back to an in-process transport in its own container, which this
 * Node process cannot see. {@link conversationFramesAvailable} says so, and the
 * route turns that into "no live view" rather than a broken stream. The observer
 * then gets what they get today: the turn banner, and the finished answer.
 */

import 'server-only'

/** A frame the backend sent to the asker, on its way to an observer. */
export interface ConversationFrame {
  /** Monotonic per conversation, assigned by the turn's owner. Used to dedupe. */
  seq: number
  /** The raw NAT WebSocket frame (`system_response_message`, …). */
  payload: unknown
}

/** Channel the backend's `ConversationBus.publish_frame` writes to. */
function conversationChannel(conversationId: string): string {
  return `conv:${conversationId}:events`
}

/** Envelope types the backend publishes on the events channel. */
const FRAME = 'frame'
const TURN_END = 'turn_end'

/** True when a cross-process frame channel exists at all. */
export function conversationFramesAvailable(): boolean {
  return Boolean(process.env.REDIS_URL)
}

/**
 * Decode one bus envelope into a frame, or `null` if it is not one we relay.
 *
 * Exported for the unit test: this is the entire contract with another service's
 * wire format, so it is worth pinning down without a Redis in the loop.
 */
export function decodeConversationFrame(raw: string): ConversationFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const envelope = parsed as { type?: unknown; seq?: unknown; payload?: unknown }
  // `turn_end` carries the terminal frame in the same `payload` slot; both are
  // worth relaying, and the observer detects the end from the frame's own
  // `status: 'complete'` rather than from the envelope, so that one client-side
  // rule covers a backend that never sets the flag.
  if (envelope.type !== FRAME && envelope.type !== TURN_END) return null
  if (envelope.payload === undefined || envelope.payload === null) return null
  const seq = typeof envelope.seq === 'number' ? envelope.seq : 0
  return { seq, payload: envelope.payload }
}

/**
 * Subscribe to one conversation's outbound frames.
 *
 * Returns an unsubscribe function that MUST be called — each subscription holds
 * its own Redis client (a subscriber connection cannot issue ordinary commands),
 * so a caller that forgets leaks one for the lifetime of the process.
 *
 * Resolves to `null` when no cross-process channel exists, so the caller can say
 * "no live view here" instead of holding a connection that can never deliver.
 */
export async function subscribeConversationFrames(
  conversationId: string,
  onFrame: (frame: ConversationFrame) => void,
): Promise<(() => Promise<void>) | null> {
  const url = process.env.REDIS_URL
  if (!url) return null

  const channel = conversationChannel(conversationId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any
  try {
    client = createSubscriberClient(url)
    await client.subscribe(channel)
  } catch (error) {
    console.warn('[conversation-frames] subscribe failed:', error)
    try {
      client?.disconnect()
    } catch {
      // Nothing to do; we are already on the failure path.
    }
    return null
  }

  client.on('message', (_channel: string, raw: string) => {
    const frame = decodeConversationFrame(raw)
    if (!frame) return
    try {
      onFrame(frame)
    } catch (error) {
      console.warn('[conversation-frames] subscriber threw:', error)
    }
  })

  return async () => {
    try {
      await client.unsubscribe(channel)
    } catch {
      // Best effort — we are tearing down anyway.
    }
    try {
      client.disconnect()
    } catch {
      // Same.
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createSubscriberClient(url: string): any {
  // Lazy require keeps ioredis out of bundles that never set REDIS_URL, exactly
  // as `./bus` does.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IORedis = require('ioredis')
  const client = new IORedis(url, {
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  })
  client.on('error', (error: unknown) => {
    console.warn('[conversation-frames] redis error:', error)
  })
  return client
}
