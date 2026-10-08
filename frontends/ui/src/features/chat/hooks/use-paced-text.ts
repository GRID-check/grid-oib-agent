/**
 * A streamed answer's text, shown at a steady pace a little behind what has
 * arrived, and whether the answer has settled on screen. The rules are in
 * `../lib/stream-pace.ts`; this is only the clock.
 *
 * The clock is `requestAnimationFrame`, and it runs only while something is
 * held back. It steps every frame but commits only when the reveal crosses a
 * word gap, so a word appears as a whole and the Markdown is re-parsed once
 * per word, not once per frame (the renderer parses only the block that grew).
 *
 * When the turn ends, the held-back rest is finished in 300–500 ms and only
 * then is the answer `settled`: the one signal everything that belongs to a
 * finished answer waits for (the caret, the footer, the Herleitung's
 * collapse). A terminal that does not continue what is shown (a rewrite, a
 * shorter text) settles at once, and so does a hidden page, where no frame
 * would ever come; a timer settles the answer if the frames stop anyway.
 *
 * Off under vitest (like the store's delta batching), so a spec that renders a
 * streaming answer sees its text at once and a finished one settled; the pace
 * has specs of its own.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  FINISH_MAX_MS,
  advancePace,
  finishCut,
  finishDuration,
  initialPace,
  keepThroughRewrite,
  noteArrival,
  type PaceState,
} from '../lib/stream-pace'

const PACING_BY_DEFAULT = process.env.NODE_ENV !== 'test'

/** How long past its planned end a finish may run before a timer settles the answer. */
export const SETTLE_GRACE_MS = 1000

export interface PacedText {
  /** What to show of the answer now. */
  text: string
  /**
   * The answer is finished AND all of it is on screen. False while it streams
   * and while the finish reveals the held-back rest; true for an answer that
   * mounts finished.
   */
  settled: boolean
}

const pageHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden'

export function usePacedText(text: string, streaming: boolean, enabled = PACING_BY_DEFAULT): PacedText {
  // An answer that mounts finished is shown whole; one that mounts streaming
  // starts from nothing and is paced from its first word.
  const paced = enabled && streaming
  const [shown, setShown] = useState(paced ? 0 : text.length)
  const [settled, setSettled] = useState(!paced)
  const pace = useRef<PaceState>(initialPace(paced ? 0 : text.length))
  const shownRef = useRef(shown)
  /** The text the shown length counts into. */
  const lastText = useRef(text)
  const latest = useRef(text)

  const show = (length: number) => {
    if (length === shownRef.current) return
    shownRef.current = length
    setShown(length)
  }

  useEffect(() => {
    latest.current = text
  })

  // An arrival, or a replacement. A snapshot that rewrites text already shown
  // keeps the shown length (moved on to a clean cut) and paces only what lies
  // beyond it; it never takes shown text back to type it out again.
  useLayoutEffect(() => {
    if (!streaming) return
    const previous = lastText.current
    lastText.current = text
    let next = pace.current
    if (!text.startsWith(previous.slice(0, shownRef.current))) {
      next = initialPace(keepThroughRewrite(text, shownRef.current))
    }
    next = noteArrival(next, text.length, performance.now())
    pace.current = next
    show(next.shown)
    // `show` only writes refs and state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, streaming])

  // A new stream in the same answer starts from what is shown.
  useLayoutEffect(() => {
    if (!streaming) return
    if (enabled) setSettled(false)
  }, [streaming, enabled])

  // Streaming and behind: step every frame, commit at word gaps.
  const behind = enabled && streaming && shown < text.length
  useEffect(() => {
    if (!behind) return
    let last = performance.now()
    let id = requestAnimationFrame(function step(now) {
      const next = advancePace(pace.current, latest.current, Math.max(0, now - last), now)
      last = now
      pace.current = next
      show(next.shown)
      id = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [behind])

  // The turn has ended: finish what is held back, then settle. Before paint,
  // so the frame the terminal lands in already shows the right thing.
  useLayoutEffect(() => {
    if (streaming || settled) return
    const settle = () => {
      lastText.current = latest.current
      pace.current = initialPace(latest.current.length)
      show(latest.current.length)
      setSettled(true)
    }
    const from = shownRef.current
    const continues = text.startsWith(lastText.current.slice(0, from))
    if (!enabled || !continues || from >= text.length || pageHidden()) {
      settle()
      return
    }
    lastText.current = text
    const duration = finishDuration(text.length - from)
    const start = performance.now()
    let id = requestAnimationFrame(function step(now) {
      const elapsed = now - start
      const cut = finishCut(latest.current, from, shownRef.current, elapsed, duration)
      if (cut >= latest.current.length) {
        settle()
        return
      }
      show(cut)
      id = requestAnimationFrame(step)
    })
    // A page hidden mid-finish gets no more frames, and frames can stop for
    // other reasons too: neither may leave the turn unsettled.
    const onHidden = () => {
      if (pageHidden()) settle()
    }
    document.addEventListener('visibilitychange', onHidden)
    const timer = window.setTimeout(settle, duration + SETTLE_GRACE_MS)
    return () => {
      cancelAnimationFrame(id)
      document.removeEventListener('visibilitychange', onHidden)
      window.clearTimeout(timer)
    }
    // `text` is read through `latest` once the finish runs: a finish is not
    // restarted by a change to the finished text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, settled, enabled])

  if (!enabled) return { text, settled: !streaming }
  if (settled) return { text, settled }
  return { text: text.slice(0, Math.min(shown, text.length)), settled }
}

/** The longest a finished turn can take to settle once its terminal frame lands. */
export const MAX_SETTLE_MS = FINISH_MAX_MS + SETTLE_GRACE_MS
