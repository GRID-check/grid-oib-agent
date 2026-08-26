'use client'

/**
 * The answer arrives all at once. This is what makes it look written.
 *
 * Nothing about the answer streams in the sense the word implies. The agent
 * finishes its whole reply, and `_response_to_chunks` (chat_researcher's
 * `register.py`) then cuts the finished text into ~24-character deltas and
 * yields them as fast as the socket takes them — a shape, not a pace. By the
 * time they reach `appendAgentResponseDelta` they are one or two animation
 * frames apart, so the reader gets a paragraph appearing whole, then another,
 * with a caret blinking at the end of an answer that was never being written.
 *
 * Pacing it server-side was the other option and it is the worse one: an
 * `asyncio.sleep` between chunks holds a worker for the length of the answer,
 * and the network re-clumps whatever the sleep spaced out. The text is already
 * in the browser; only the REVEAL needs a clock, and the browser owns one.
 *
 * WHAT IT REVEALS, and what it refuses to:
 *  - Only what arrives AFTER mount. An answer read back from history mounts
 *    complete, and its whole length is revealed on the first render — a thread
 *    that types itself out on every scroll-back would be a bug, not an effect.
 *  - Only a pure EXTENSION of what is on screen. The terminal frame replaces
 *    the accumulated text with the authoritative answer, and a session swap
 *    hands the same component a different one; neither is something to type, so
 *    anything that is not the current text plus more is shown as it is.
 *  - Nothing at all under `prefers-reduced-motion`. Text that arrives at its
 *    own pace is exactly what that setting is about.
 *
 * The rate is a DEADLINE, not a typing speed. When text arrives, the reveal
 * plans when it will be finished — whatever is waiting, drained over at most
 * {@link CATCHUP_SECONDS}, and never faster than {@link MIN_CHARS_PER_SECOND}
 * so a two-line answer still reads as written rather than blinking into place —
 * and each frame takes the share of the backlog the remaining time is worth. A
 * short answer and a long report therefore finish in about the same time, which
 * is the property that keeps the effect from becoming a wait. Deriving the rate
 * from the backlog alone instead would decay: the faster it catches up the
 * slower it goes, and a long report would trail for seven seconds.
 */

import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '@/hooks/use-reduced-motion'

/**
 * The floor, in characters per second. Below roughly this the reveal stops
 * reading as an answer being written and starts reading as a slow connection.
 */
const MIN_CHARS_PER_SECOND = 220

/**
 * The longest the reveal may take. The whole effect is bounded by this: a
 * 600-character answer and a 6,000-character report both finish in about two
 * seconds, because the rate is set from what is waiting rather than fixed.
 */
const CATCHUP_SECONDS = 2

/** One frame at 60Hz — the floor on "time left", so the rate never divides by zero. */
const MIN_FRAME_MS = 16

/**
 * The shortest gap between two reveals. Every one of them re-parses the answer
 * as markdown (remark, the citation and card marker plugins, react-markdown),
 * so a reveal at the display's full rate would pay that on every frame for as
 * long as it runs — the one cost this effect can actually impose on a reader.
 * At ~30/s the growth is still continuous to the eye and the parse bill halves.
 * Skipping a frame does not slow the reveal: the step is computed from the time
 * SINCE the last one, so the next reveal is simply bigger.
 */
const MIN_UPDATE_MS = 32

/** Where the reveal can run at all: a browser with a frame clock, outside tests. */
const PACING_AVAILABLE =
  typeof window !== 'undefined' &&
  typeof window.requestAnimationFrame === 'function' &&
  // Same reason the store's delta batching opts out: specs append then read
  // synchronously, and this branch tree-shakes out of the browser bundle.
  process.env.NODE_ENV !== 'test'

export interface TypedReveal {
  /** The prefix of `content` the reader may see this frame. */
  text: string
  /** True while `text` is still behind `content`. */
  isTyping: boolean
}

export interface TypedRevealOptions {
  /**
   * Force the reveal on or off. Left unset it runs wherever it can — which is
   * never under vitest, so this is how this hook's own spec drives it.
   */
  paced?: boolean
}

/**
 * A surrogate pair is one character to the reader and two to `slice`, so a cut
 * between them renders as `�` for a frame. Step back onto the pair's boundary.
 */
const wholeCharacters = (text: string, end: number): number => {
  if (end <= 0 || end >= text.length) return end
  const previous = text.charCodeAt(end - 1)
  return previous >= 0xd800 && previous <= 0xdbff ? end - 1 : end
}

/** Reveal `content` at a readable pace as it grows. See the module header. */
export function useTypedReveal(content: string, options: TypedRevealOptions = {}): TypedReveal {
  const prefersReducedMotion = useReducedMotion()
  const paced = options.paced ?? (PACING_AVAILABLE && !prefersReducedMotion)

  const [revealed, setRevealed] = useState(() => content.length)
  // The frame loop's own counter. State drives the render; this drives the
  // loop, so a frame never reads a `revealed` React has not committed yet.
  const revealedRef = useRef(revealed)
  const previousContentRef = useRef(content)
  // When the text on screen is due to have caught up, in frame-clock time.
  // Re-planned whenever more arrives, so a backend that really did stream would
  // simply keep setting a small one and run at the floor.
  const dueRef = useRef<number | null>(null)

  useEffect(() => {
    const previous = previousContentRef.current
    previousContentRef.current = content

    if (!paced || !content.startsWith(previous)) {
      revealedRef.current = content.length
      setRevealed(content.length)
      return
    }
    if (revealedRef.current >= content.length) return
    dueRef.current = null

    // `null`, not 0: a frame clock that starts at zero would read as "no
    // previous frame" forever and every step would measure nothing.
    let lastFrameTime: number | null = null
    let frame = requestAnimationFrame(function tick(now: number) {
      if (lastFrameTime === null) lastFrameTime = now
      const sinceLastFrame = now - lastFrameTime
      if (sinceLastFrame > 0 && sinceLastFrame < MIN_UPDATE_MS) {
        frame = requestAnimationFrame(tick)
        return
      }
      lastFrameTime = now

      const backlog = content.length - revealedRef.current
      if (dueRef.current === null) {
        dueRef.current = now + Math.min(CATCHUP_SECONDS * 1000, (backlog / MIN_CHARS_PER_SECOND) * 1000)
      }
      // One frame of headroom, so the last frame before the deadline asks for
      // the rest rather than dividing by zero.
      const remaining = Math.max(dueRef.current - now, MIN_FRAME_MS)
      // At least one character per frame: a share that rounds to zero on a fast
      // display would stall the reveal instead of slowing it.
      const step = Math.max(1, Math.ceil(backlog * (sinceLastFrame / remaining)))
      const next = Math.min(content.length, revealedRef.current + step)

      revealedRef.current = next
      setRevealed(next)
      if (next < content.length) frame = requestAnimationFrame(tick)
    })

    return () => cancelAnimationFrame(frame)
  }, [content, paced])

  if (revealed >= content.length) return { text: content, isTyping: false }
  return { text: content.slice(0, wholeCharacters(content, revealed)), isTyping: true }
}
