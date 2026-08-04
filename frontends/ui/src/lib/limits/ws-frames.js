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
 * It reads at most `MAX_PEEK` bytes of each frame's payload — enough to see the
 * `type` field the client writes first — and never buffers a whole message. A
 * frame it cannot classify is charged as CHEAP, not expensive: this is an abuse
 * bound, and a caller who fragments cleverly to dodge the expensive class still
 * has to get past the cheap rule. CommonJS for the same reason as its siblings:
 * `server.js` cannot import TypeScript.
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
 * @property {number} opcode
 * @property {string} peek Unmasked leading payload bytes, '' for non-text.
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
  let masked = false
  /** @type {Buffer|null} */
  let maskKey = null
  let payloadRemaining = 0
  let maskOffset = 0
  /** @type {Buffer[]} */
  let peeked = []
  let peekedBytes = 0

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

  const finishFrame = () => {
    const peek = peeked.length ? Buffer.concat(peeked).toString('utf8') : ''
    peeked = []
    peekedBytes = 0
    maskOffset = 0
    state = 'header'
    try {
      onFrame({ opcode, peek })
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

        if (opcode === OPCODE.TEXT && peekedBytes < MAX_PEEK) {
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
 * `'chat-turn'` only when the frame positively identifies itself as a user
 * message — the one thing that starts an agent run. Anything unrecognised
 * (a continuation fragment, a binary frame, a payload past the peek window)
 * falls through to `'control'` rather than being assumed expensive: charging
 * the wrong rule would refuse honest traffic, which is the failure mode an
 * abuse bound must avoid. `'ignore'` is for the close handshake, which must
 * never be throttled or the socket cannot shut down cleanly.
 *
 * @param {ObservedFrame} frame
 * @returns {'chat-turn' | 'control' | 'ignore'}
 */
function classifyFrame(frame) {
  if (frame.opcode === OPCODE.CLOSE) return 'ignore'
  if (frame.opcode === OPCODE.TEXT && /"type"\s*:\s*"user_message"/.test(frame.peek)) {
    return 'chat-turn'
  }
  return 'control'
}

module.exports = { createFrameObserver, classifyFrame, MAX_PEEK, OPCODE }
