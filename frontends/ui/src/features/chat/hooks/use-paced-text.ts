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
 * A turn the reader stopped settles at once at what is shown, and keeps it.
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
  furthestCleanCut,
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
  /**
   * The reveal has not moved for `IDLE_AFTER_MS` while the answer is unsettled:
   * the model is thinking between sentences. The caret stands solid while words
   * advance and breathes only then, as a text editor's does. Flips once per
   * stall, so it costs a render per pause, not per frame.
   */
  idle: boolean
}

/** How long the reveal stands still before the answer counts as idle. */
export const IDLE_AFTER_MS = 600

const pageHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden'

/**
 * More text than an answer is born with. A live answer mounts on the store
 * flush that brought its first words (35 and 63 characters on the recorded
 * turns); one that mounts with more than this is a turn joined mid-way: a
 * reload's replay, a spectator arriving, a thread opened again.
 */
export const ARRIVED_AT_MOUNT_CHARS = 400

/**
 * The answers being revealed on this page, by id. One that mounts again while
 * it is still in here (the reader switched threads and came back) had its
 * text on screen already, and is not typed out a second time.
 */
const onScreen = new Set<string>()

/**
 * Where the reveal of an answer that mounts streaming starts. From nothing,
 * when the reader is watching it be born. From the furthest clean cut of what
 * has arrived, when the text was already there to be read: it had been shown
 * before the remount (`id` in `onScreen`), or the turn was joined mid-way.
 * Re-typing it read as the answer being written again (L27, L28).
 */
function startingLength(text: string, id: string | undefined, leadChars: number): number {
  const joinedMidway = (id !== undefined && onScreen.has(id)) || text.length - leadChars > ARRIVED_AT_MOUNT_CHARS
  return joinedMidway ? furthestCleanCut(text, 0, text.length) : 0
}

/**
 * `stopped`: the reader pressed Stop (`ChatMessage.stopped`), or the turn
 * failed under the answer. What they saw is what stays: the held-back rest is
 * not typed out after the press, and the shown text is held for as long as
 * this answer is mounted, so the server's cancelled terminal (which carries
 * everything the model had written) does not swap a longer text in under the
 * reader. A reload shows the stored one.
 *
 * `id`: the answer's message id, which lets a remount mid-turn start where
 * the reader was rather than at the first word (`startingLength`).
 *
 * `leadChars`: how much of `text` is a head that arrives whole by design (the
 * masthead's summary, written in ahead of the prose). It is paced like the
 * rest, but not counted toward `ARRIVED_AT_MOUNT_CHARS`: a fresh answer is
 * born with all of it, and counting it read a 300-character summary plus the
 * first words as a turn joined mid-way, shown at once.
 */
export function usePacedText(
  text: string,
  streaming: boolean,
  enabled = PACING_BY_DEFAULT,
  stopped = false,
  id?: string,
  leadChars = 0
): PacedText {
  // An answer that mounts finished is shown whole; one that mounts streaming
  // is paced from its first word, or from what had already arrived when the
  // turn was joined mid-way.
  const paced = enabled && streaming
  const [start] = useState(() => (paced ? startingLength(text, id, leadChars) : text.length))
  const [shown, setShown] = useState(start)
  const [settled, setSettled] = useState(!paced)
  const pace = useRef<PaceState>(initialPace(start))
  const shownRef = useRef(shown)
  /** The text the shown length counts into. */
  const lastText = useRef(text)
  const latest = useRef(text)
  /** The text on screen when Stop was pressed, held from then on. */
  const [frozen, setFrozen] = useState<string | null>(null)

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

  // On screen until settled: a remount before then starts where it was.
  useEffect(() => {
    if (!id || !enabled) return
    if (settled) onScreen.delete(id)
    else onScreen.add(id)
  }, [id, enabled, settled])

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

  // Idle: the shown length the reveal stood still at for `IDLE_AFTER_MS`.
  // Kept as that length rather than a flag, so the next word ends the idle
  // by itself, without a second render to clear it.
  const [idleAt, setIdleAt] = useState(-1)
  useEffect(() => {
    if (!enabled || settled) return
    const timer = window.setTimeout(() => setIdleAt(shown), IDLE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [shown, settled, enabled])

  // The turn has ended: finish what is held back, then settle. Before paint,
  // so the frame the terminal lands in already shows the right thing.
  useLayoutEffect(() => {
    if (streaming || settled) return
    // Stopped: settle at what is shown, now. Typing on after the press reads
    // as the button not having worked.
    if (stopped) {
      setFrozen(text.slice(0, shownRef.current))
      setSettled(true)
      return
    }
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
  }, [streaming, settled, enabled, stopped])

  if (frozen !== null) return { text: frozen, settled: true, idle: false }
  if (!enabled) return { text, settled: !streaming, idle: false }
  if (settled) return { text, settled, idle: false }
  return { text: text.slice(0, Math.min(shown, text.length)), settled, idle: idleAt === shown }
}

/** The longest a finished turn can take to settle once its terminal frame lands. */
export const MAX_SETTLE_MS = FINISH_MAX_MS + SETTLE_GRACE_MS
