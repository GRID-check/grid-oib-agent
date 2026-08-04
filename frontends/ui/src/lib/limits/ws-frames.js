/**
 * Counting what a client sends on an OPEN WebSocket (ADR-0040 layer L2b).
 *
 * ## Why this exists at all
 *
 * Chat is WebSocket-only (ADR-0009), so the edge sees exactly one HTTP request
 * per session — the upgrade — and nothing afterwards. Every chat turn, and
 * therefore every multi-agent research run a user can start, rides an already
 * open socket. No gateway policy that will ever be written can see them. The
 * proxy that owns the socket is the only place that can, which is why this is
 * the one layer of ADR-0040 that had to be built rather than configured.
 *
 * ## How
 *
 * `server.js` splices the client socket straight to the backend with
 * `http-proxy` — frames are never parsed. Rather than terminate and re-emit the
 * protocol (a large change to a load-bearing path), this module observes the
 * client's byte stream passively: attach it as an extra `data` listener and it
 * tracks frame boundaries without touching what gets forwarded.
 *
 * It must therefore stay in sync with the framing, which is why this is a real
 * incremental parser and not a regex over chunks: a TCP chunk can carry several
 * frames, one frame can span chunks, and losing sync would silently stop the
 * limiter forever.
 *
 * ## What it deliberately does NOT do
 *
 * It reads at most `MAX_PEEK` bytes of a MESSAGE's payload — enough to see the
 * `type` field the client writes first — and never buffers a whole message.
 *
 * The peek accumulates across a message's FRAGMENTS, and that is deliberate: a
 * client can legally split one text message into an initial frame plus
 * continuations, so hiding `"type":"user_message"` past the first 512 bytes
 * would otherwise buy the cheap `ws-control` budget for something that starts an
 * agent run. Accumulating means the fragment that reveals the type is charged as
 * the chat turn it is. The trade is that a fragmented user message is charged
 * once per fragment from that point on — over-charging a client that fragments
 * to hide, never under-charging it, and no honest client fragments a few hundred
 * bytes of JSON.
 *
 * An UNFRAGMENTED frame it cannot classify is charged as CHEAP, not expensive:
 * charging the wrong rule would refuse honest traffic, which is the failure an
 * abuse bound must avoid. A fragmented one goes the other way — see
 * `classifyFrame`. CommonJS for the same reason as its siblings: `server.js`
 * cannot import TypeScript.
 */

/** Payload bytes inspected per frame. The client writes `type` first. */
const MAX_PEEK = 512

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
}

/**
 * @typedef {Object} ObservedFrame
 * @property {number} opcode Effective opcode: a continuation reports the opcode
 *   of the message it belongs to, not 0.
 * @property {string} peek Unmasked leading bytes of the MESSAGE so far
 *   (accumulated across fragments), '' for control frames.
 * @property {boolean} fragmented Whether this frame is part of a fragmented
 *   message (a non-FIN frame or any continuation of one).
 */

/**
 * A passive frame counter for ONE client socket.
 *
 * @param {(frame: ObservedFrame) => void} onFrame Called once per complete
 *   frame. Never throws into the caller — a listener that throws would take
 *   down the data path it is observing.
 * @returns {{ push(chunk: Buffer): void }}
 */
function createFrameObserver(onFrame) {
  /** @type {Buffer} */
  let pending = Buffer.alloc(0)
  let state = 'header'
  let opcode = 0
  let fin = true
  let masked = false
  /** @type {Buffer|null} */
  let maskKey = null
  let payloadRemaining = 0
  let maskOffset = 0
  // Peek accumulates across the FRAGMENTS of one message, not per frame — see
  // the header. Reset when a message completes (FIN), never by a control frame
  // interleaved between fragments.
  /** @type {Buffer[]} */
  let peeked = []
  let peekedBytes = 0
  /** Opcode of the fragmented message in progress, or 0 when between messages. */
  let messageOpcode = 0

  /** Header length once the first two bytes are known, or null if unknowable. */
  const headerLength = (buf) => {
    if (buf.length < 2) return null
    const len7 = buf[1] & 0x7f
    const isMasked = (buf[1] & 0x80) !== 0
    const extended = len7 === 126 ? 2 : len7 === 127 ? 8 : 0
    return 2 + extended + (isMasked ? 4 : 0)
  }

  const readPayloadLength = (buf) => {
    const len7 = buf[1] & 0x7f
    if (len7 === 126) return buf.readUInt16BE(2)
    // A frame longer than 2^53 bytes is not a thing; the high word is 0 in
    // every real client, and Number() keeps the arithmetic below simple.
    if (len7 === 127) return Number(buf.readBigUInt64BE(2))
    return len7
  }

  const isControl = (code) => (code & 0x8) !== 0

  const finishFrame = () => {
    const control = isControl(opcode)
    // A continuation carries the opcode of the message it belongs to, so a
    // fragment that reveals `"type":"user_message"` is charged as the chat turn
    // it is rather than as a cheap control frame.
    const effectiveOpcode =
      opcode === OPCODE.CONTINUATION && messageOpcode ? messageOpcode : opcode
    const peek = control || !peeked.length ? '' : Buffer.concat(peeked).toString('utf8')
    const fragmented = !control && (!fin || opcode === OPCODE.CONTINUATION)

    if (!control) {
      if (fin) {
        // Message complete: start the next one from nothing.
        peeked = []
        peekedBytes = 0
        messageOpcode = 0
      } else if (!messageOpcode) {
        messageOpcode = opcode
      }
    }

    maskOffset = 0
    state = 'header'
    try {
      onFrame({ opcode: effectiveOpcode, peek, fragmented })
    } catch {
      // Observing must never break the connection it observes.
    }
  }

  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) return
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])

      for (;;) {
        if (state === 'header') {
          const needed = headerLength(pending)
          if (needed === null || pending.length < needed) return

          opcode = pending[0] & 0x0f
          fin = (pending[0] & 0x80) !== 0
          masked = (pending[1] & 0x80) !== 0
          payloadRemaining = readPayloadLength(pending)
          maskKey = masked ? pending.subarray(needed - 4, needed) : null
          pending = pending.subarray(needed)
          state = 'payload'
          // A zero-length frame (a bare pong, a close) completes immediately.
          if (payloadRemaining === 0) {
            finishFrame()
            continue
          }
        }

        if (pending.length === 0) return
        const take = Math.min(payloadRemaining, pending.length)

        // Accumulate for TEXT and its continuations; control frames are not
        // part of any message and must not pollute the accumulator.
        const peekable =
          opcode === OPCODE.TEXT ||
          (opcode === OPCODE.CONTINUATION && messageOpcode === OPCODE.TEXT)
        if (peekable && peekedBytes < MAX_PEEK) {
          const wanted = Math.min(take, MAX_PEEK - peekedBytes)
          const slice = Buffer.from(pending.subarray(0, wanted))
          if (maskKey) {
            for (let i = 0; i < slice.length; i++) {
              slice[i] ^= maskKey[(maskOffset + i) % 4]
            }
          }
          peeked.push(slice)
          peekedBytes += slice.length
        }

        maskOffset = (maskOffset + take) % 4
        payloadRemaining -= take
        pending = pending.subarray(take)
        if (payloadRemaining === 0) finishFrame()
      }
    },
  }
}

/**
 * What a frame costs.
 *
 * `'chat-turn'` when the message identifies itself as a user message — the one
 * thing that starts an agent run — or when it was fragmented at all. An
 * unrecognised, unfragmented frame (a binary frame, a payload past the peek
 * window) falls through to `'control'` rather than being assumed expensive: charging
 * the wrong rule would refuse honest traffic, which is the failure mode an
 * abuse bound must avoid. `'ignore'` is for the close handshake, which must
 * never be throttled or the socket cannot shut down cleanly.
 *
 * @param {ObservedFrame} frame
 * @returns {'chat-turn' | 'control' | 'ignore'}
 */
function classifyFrame(frame) {
  if (frame.opcode === OPCODE.CLOSE) return 'ignore'
  if (frame.opcode !== OPCODE.TEXT) return 'control'
  if (/"type"\s*:\s*"user_message"/.test(frame.peek)) return 'chat-turn'
  // A FRAGMENTED text message is charged as a chat turn even when the peek
  // never revealed a type. Accumulating across fragments (above) is not enough
  // on its own: a client can pad past `MAX_PEEK` before writing `type` and the
  // window closes before the answer arrives. Fragmentation is itself the tell —
  // this app's client sends one frame per message (`websocket-client.ts` calls
  // `ws.send` with a complete JSON string), so splitting a few hundred bytes of
  // JSON is not something honest traffic does. Charging the expensive rule here
  // costs a well-behaved oddity nothing it can notice, and closes the only way
  // left to buy 40x the agent runs.
  if (frame.fragmented) return 'chat-turn'
  return 'control'
}

module.exports = { createFrameObserver, classifyFrame, MAX_PEEK, OPCODE }
