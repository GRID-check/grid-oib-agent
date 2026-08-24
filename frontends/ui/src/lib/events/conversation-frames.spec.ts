/**
 * @vitest-environment node
 */
/**
 * The wire contract with the Python tier's conversation bus.
 *
 * This decoder is the entire seam between two services written in two languages,
 * and it is a seam nothing else in the frontend exercises. Pinning it here means a
 * change to `conversation_bus.Envelope` fails a test rather than silently emptying
 * every observer's live view — the one failure mode that looks, from the browser,
 * exactly like "the agent is being slow".
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  conversationFramesAvailable,
  decodeConversationFrame,
} from './conversation-frames'

/** An envelope in the shape `ConversationBus.publish_frame` writes. */
function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    conv: 'conv_1',
    seq: 7,
    origin: 'aiq-agent-0:abc123',
    type: 'frame',
    payload: { type: 'system_response_message', status: 'in_progress', content: { text: 'Hi' } },
    ...overrides,
  })
}

describe('decodeConversationFrame', () => {
  it('unwraps a frame envelope, keeping seq and payload', () => {
    const frame = decodeConversationFrame(envelope())
    expect(frame).toEqual({
      seq: 7,
      payload: { type: 'system_response_message', status: 'in_progress', content: { text: 'Hi' } },
    })
  })

  it('relays a terminal envelope too', () => {
    // `turn_end` carries the last frame in the same slot. Dropping it would cost
    // the observer the authoritative full answer.
    expect(decodeConversationFrame(envelope({ type: 'turn_end' }))?.seq).toBe(7)
  })

  it('drops control envelopes that are not frames', () => {
    for (const type of ['hitl_answer', 'cancel', 'supersede', 'reconnect']) {
      expect(decodeConversationFrame(envelope({ type }))).toBeNull()
    }
  })

  it('drops malformed input rather than throwing', () => {
    for (const raw of ['', 'not json', '[]', 'null', '"a string"', '{}']) {
      expect(decodeConversationFrame(raw)).toBeNull()
    }
  })

  it('drops an envelope with no payload', () => {
    expect(decodeConversationFrame(envelope({ payload: null }))).toBeNull()
  })

  it('tolerates a missing sequence number', () => {
    // seq 0 means "unnumbered"; the frame is still worth relaying, because the
    // client's dedupe is an optimisation and a lost token is not.
    expect(decodeConversationFrame(envelope({ seq: undefined }))?.seq).toBe(0)
  })
})

describe('conversationFramesAvailable', () => {
  const original = process.env.REDIS_URL

  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = original
  })

  it('is false with no shared cache tier, so the route can say so once', () => {
    delete process.env.REDIS_URL
    expect(conversationFramesAvailable()).toBe(false)
  })

  it('is true when one is configured', () => {
    process.env.REDIS_URL = 'redis://dragonfly:6379'
    expect(conversationFramesAvailable()).toBe(true)
  })
})
