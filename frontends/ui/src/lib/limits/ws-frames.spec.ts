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
  fragmented: boolean
}

/** Build a client→server frame the way a browser does: always masked. */
function frame(opcode: number, payload: string | Buffer = '', fin = true): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d])
  const first = (fin ? 0x80 : 0x00) | opcode

  let header: Buffer
  if (body.length < 126) {
    header = Buffer.from([first, 0x80 | body.length])
  } else if (body.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = first
    header[1] = 0x80 | 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = first
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
    expect(classifyFrame({ opcode: 0x1, peek: userMessage, fragmented: false })).toBe('chat-turn')
  })

  it('charges anything it cannot positively identify as cheap, not expensive', () => {
    // Charging the wrong rule would refuse honest traffic — the failure mode an
    // abuse bound must avoid.
    expect(classifyFrame({ opcode: 0x1, peek: interaction, fragmented: false })).toBe('control')
    expect(classifyFrame({ opcode: 0x1, peek: '{"typ', fragmented: false })).toBe('control')
    expect(classifyFrame({ opcode: 0x2, peek: '', fragmented: false })).toBe('control')
    expect(classifyFrame({ opcode: 0x9, peek: '', fragmented: false })).toBe('control')
  })

  it('never throttles the close handshake', () => {
    // A rate-limited close frame would leave sockets unable to shut down.
    expect(classifyFrame({ opcode: 0x8, peek: '', fragmented: false })).toBe('ignore')
  })
})

describe('fragmented messages', () => {
  it('classifies a message whose type only appears in a continuation', () => {
    // The bypass this closes: split the message so the type never appears in
    // the peek window, and every fragment would otherwise be charged as a cheap
    // control frame — buying roughly 40x the agent runs the budget allows.
    // 600 bytes of padding outruns MAX_PEEK entirely, so accumulation alone
    // cannot save it; fragmentation itself is what condemns it.
    const head = '{"padding":"' + 'p'.repeat(600) + '",'
    const tail = '"type":"user_message","id":"m1"}'
    const seen = collect([
      Buffer.concat([frame(0x1, head, false), frame(0x0, tail, true)]),
    ])

    expect(seen).toHaveLength(2)
    expect(seen.map(classifyFrame)).toEqual(['chat-turn', 'chat-turn'])
  })

  it('reports a continuation under its message opcode, not as opcode 0', () => {
    const seen = collect([
      Buffer.concat([frame(0x1, '{"type":', false), frame(0x0, '"user_message"}', true)]),
    ])

    expect(seen[1].opcode).toBe(0x1)
    expect(classifyFrame(seen[1])).toBe('chat-turn')
  })

  it('does not let a control frame between fragments reset the accumulator', () => {
    // Ping/pong may legally interleave with a fragmented message. If they wiped
    // the peek, interleaving would restore the bypass.
    const seen = collect([
      Buffer.concat([
        frame(0x1, '{"type":', false),
        frame(0x9),
        frame(0x0, '"user_message"}', true),
      ]),
    ])

    expect(seen.map((f) => f.opcode)).toEqual([0x1, 0x9, 0x1])
    expect(classifyFrame(seen[2])).toBe('chat-turn')
  })

  it('starts a fresh message after FIN', () => {
    const seen = collect([
      Buffer.concat([
        frame(0x1, '{"type":"user_message"}', true),
        frame(0x1, '{"type":"user_interaction_message"}', true),
      ]),
    ])

    // A completed message must not leak its classification into the next one.
    expect(classifyFrame(seen[0])).toBe('chat-turn')
    expect(classifyFrame(seen[1])).toBe('control')
  })

  it('stays in sync when a frame declares a huge 127-encoded length', () => {
    // A client that declares more than it sends leaves the parser mid-payload.
    // What matters is that it cannot make the observer emit phantom frames.
    const header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(1_000_000), 2)
    const seen = collect([
      Buffer.concat([header, Buffer.from([0, 0, 0, 0]), Buffer.from('short')]),
    ])

    expect(seen).toHaveLength(0)
  })
})
