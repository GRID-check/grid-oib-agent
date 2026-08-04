/**
 * The WebSocket frame observer (ADR-0040 L2b).
 *
 * The property under test is SYNC. This parser rides a live byte stream it does
 * not control: if it ever mis-computes one frame's length it stays wrong
 * forever, and the limiter it feeds silently stops counting on that socket. So
 * the cases below are mostly about boundaries — several frames in one chunk,
 * one frame split across chunks, each extended-length encoding — rather than
 * about the happy path.
 */

import { describe, expect, it } from 'vitest'
import { classifyFrame, createFrameObserver } from './ws-frames.js'

interface Observed {
  opcode: number
  peek: string
}

/** Build a client→server frame the way a browser does: always masked. */
function frame(opcode: number, payload: string | Buffer = ''): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d])

  let header: Buffer
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length])
  } else if (body.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }

  const masked = Buffer.from(body)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

function collect(chunks: Buffer[]): Observed[] {
  const seen: Observed[] = []
  const observer = createFrameObserver((f: Observed) => seen.push(f))
  for (const chunk of chunks) observer.push(chunk)
  return seen
}

const userMessage = JSON.stringify({ type: 'user_message', id: 'm1', content: { messages: [] } })
const interaction = JSON.stringify({ type: 'user_interaction_message', id: 'm2' })

describe('createFrameObserver', () => {
  it('reads a single text frame and unmasks enough to classify it', () => {
    const seen = collect([frame(0x1, userMessage)])

    expect(seen).toHaveLength(1)
    expect(seen[0].opcode).toBe(0x1)
    expect(seen[0].peek).toContain('"type":"user_message"')
  })

  it('reads several frames arriving in ONE chunk', () => {
    const seen = collect([
      Buffer.concat([frame(0x1, userMessage), frame(0x1, interaction), frame(0x9)]),
    ])

    expect(seen.map((f) => f.opcode)).toEqual([0x1, 0x1, 0x9])
    expect(seen[1].peek).toContain('user_interaction_message')
  })

  it('reads one frame split byte-by-byte across chunks', () => {
    const bytes = frame(0x1, userMessage)
    const seen = collect([...bytes].map((b) => Buffer.from([b])))

    // The pathological split: if the parser ever needed a whole frame in one
    // chunk, this is where it would fail.
    expect(seen).toHaveLength(1)
    expect(seen[0].peek).toContain('"type":"user_message"')
  })

  it('stays in sync across a 126-byte extended length', () => {
    const long = 'x'.repeat(300)
    const seen = collect([Buffer.concat([frame(0x1, long), frame(0x1, userMessage)])])

    expect(seen).toHaveLength(2)
    // Sync survived the first frame, so the SECOND is still classifiable.
    expect(seen[1].peek).toContain('"type":"user_message"')
  })

  it('stays in sync across a 127-byte extended length', () => {
    const huge = 'y'.repeat(70_000)
    const seen = collect([Buffer.concat([frame(0x1, huge), frame(0x1, userMessage)])])

    expect(seen).toHaveLength(2)
    expect(seen[1].peek).toContain('"type":"user_message"')
  })

  it('caps how much of a payload it inspects', () => {
    const seen = collect([frame(0x1, 'z'.repeat(4000))])

    // Never buffers a whole message — it is watching a stream, not collecting it.
    expect(seen[0].peek.length).toBeLessThanOrEqual(512)
  })

  it('reports zero-length control frames', () => {
    const seen = collect([Buffer.concat([frame(0x9), frame(0xa), frame(0x8)])])

    expect(seen.map((f) => f.opcode)).toEqual([0x9, 0xa, 0x8])
  })
})

describe('classifyFrame', () => {
  it('charges a user message as a chat turn', () => {
    expect(classifyFrame({ opcode: 0x1, peek: userMessage })).toBe('chat-turn')
  })

  it('charges anything it cannot positively identify as cheap, not expensive', () => {
    // Charging the wrong rule would refuse honest traffic — the failure mode an
    // abuse bound must avoid.
    expect(classifyFrame({ opcode: 0x1, peek: interaction })).toBe('control')
    expect(classifyFrame({ opcode: 0x1, peek: '{"typ' })).toBe('control')
    expect(classifyFrame({ opcode: 0x2, peek: '' })).toBe('control')
    expect(classifyFrame({ opcode: 0x9, peek: '' })).toBe('control')
  })

  it('never throttles the close handshake', () => {
    // A rate-limited close frame would leave sockets unable to shut down.
    expect(classifyFrame({ opcode: 0x8, peek: '' })).toBe('ignore')
  })
})
