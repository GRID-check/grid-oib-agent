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
 * The peek accumulates across a message's FRAGMENTS rather than resetting per
 * frame, because a client may legally split one text message into an initial
 * frame plus continuations, and a type revealed by the third fragment still
 * belongs to the message as a whole.
 *
 * Accumulating is not sufficient on its own, though, and that shapes
 * `classifyFrame`: a client controls its own bytes, so it can pad past
 * `MAX_PEEK` before writing `type` — in one frame or several — and the window
 * closes before the answer arrives. So the classifier keys on whether the whole
 * message was READ, not on whether it was recognised, and this parser reports
 * `truncated` and `fragmented` to let it. Anything unread is charged the
 * expensive rule; anything read in full and found not to be a user message is
 * charged the cheap one, which is a fact rather than a guess.
 *
 * The residual cost is one-sided by construction: a message that hides its type
 * is over-charged, never under-charged, and no honest client pads or fragments a
 * few hundred bytes of JSON. CommonJS for the same reason as its siblings:
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
 * @property {number} opcode Effective opcode: a continuation reports the opcode
 *   of the message it belongs to, not 0.
 * @property {string} peek Unmasked leading bytes of the MESSAGE so far
 *   (accumulated across fragments), '' for control frames.
 * @property {boolean} fragmented Whether this frame is part of a fragmented
 *   message (a non-FIN frame or any continuation of one).
 * @property {boolean} truncated Whether the message carried more payload than
 *   the peek window could read, so `peek` is a prefix rather than the whole of
 *   it. Always false for control frames, which are not peeked.
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
  /**
   * Whether this message had payload the peek window could not reach.
   *
   * The difference that matters to `classifyFrame`: a message read in FULL and
   * found not to be a `user_message` definitively is not one, while a message
   * whose tail we never saw could be hiding anything past the padding.
   */
  let peekTruncated = false
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

    const truncated = !control && peekTruncated

    if (!control) {
      if (fin) {
        // Message complete: start the next one from nothing.
        peeked = []
        peekedBytes = 0
        peekTruncated = false
        messageOpcode = 0
      } else if (!messageOpcode) {
        messageOpcode = opcode
      }
    }

    maskOffset = 0
    state = 'header'
    try {
      onFrame({ opcode: effectiveOpcode, peek, fragmented, truncated })
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
        if (peekable) {
          if (peekedBytes < MAX_PEEK) {
            const wanted = Math.min(take, MAX_PEEK - peekedBytes)
            const slice = Buffer.from(pending.subarray(0, wanted))
            if (maskKey) {
              for (let i = 0; i < slice.length; i++) {
                slice[i] ^= maskKey[(maskOffset + i) % 4]
              }
            }
            peeked.push(slice)
            peekedBytes += slice.length
            // More payload than window: the rest of this message is unread.
            if (take > wanted) peekTruncated = true
          } else {
            // Window already full and payload still arriving.
            peekTruncated = true
          }
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
 * thing that starts an agent run — or when the peek could not rule one out.
 * `'ignore'` is for the close handshake, which must never be throttled or the
 * socket cannot shut down cleanly.
 *
 * The rule that decides the rest is **whether the whole message was read**, not
 * whether it was recognised:
 *
 *   - Read in FULL and not a `user_message` → definitively not one. Cheap, and
 *     that is a fact rather than an assumption. This is the honest client's
 *     path: interaction and control messages are small, so the window sees all
 *     of them.
 *   - NOT read in full (padded past `MAX_PEEK`, or fragmented) → nothing can be
 *     concluded, so charge the expensive rule.
 *
 * Both un-read cases exist because a client controls its own bytes. It can pad
 * with 600 bytes of JSON before writing `type`, in one frame or split across
 * several, and either way the window closes before the answer arrives —
 * accumulating the peek across fragments does not save it. Charging cheap on
 * "unrecognised" is what turns that into roughly 40x the agent runs the budget
 * allows; charging expensive on "unread" closes both doors with one rule.
 *
 * This app's client sends one small `ws.send` per message with `type` first
 * (`websocket-client.ts`), so no honest frame reaches either un-read case. The
 * cost of being wrong is bounded and one-sided: an unusual-but-honest large
 * message is charged the stricter budget, never refused outright by
 * misclassification of something small.
 *
 * @param {ObservedFrame} frame
 * @returns {'chat-turn' | 'control' | 'ignore'}
 */
function classifyFrame(frame) {
  if (frame.opcode === OPCODE.CLOSE) return 'ignore'
  if (frame.opcode !== OPCODE.TEXT) return 'control'
  if (/"type"\s*:\s*"user_message"/.test(frame.peek)) return 'chat-turn'
  if (frame.fragmented || frame.truncated) return 'chat-turn'
  return 'control'
}

module.exports = { createFrameObserver, classifyFrame, MAX_PEEK, OPCODE }
