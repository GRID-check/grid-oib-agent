/**
 * The pace a streamed answer is shown at: a steady reveal a little behind what
 * has arrived, instead of the text jumping forward in whatever clumps the
 * model, the network and the store batching happen to deliver.
 *
 * Why it exists (2026-09): the prose streams while the model writes it
 * (ADR-0066), and it arrives in bursts, a sentence at once and then nothing
 * for half a second. Painted as it arrives, the answer lurches. Shown a beat
 * behind at a steady rate, it reads as being written. This is not the
 * typewriter ADR-0066 removed: that one simulated a latency the system did not
 * have, over text that was already finished; this one smooths a latency the
 * system does have, and never holds text back longer than `MAX_LAG_MS`.
 *
 * Only a streaming answer is paced. A finished one is shown whole at once:
 * the terminal frame is authoritative, and pacing it made the answer drain
 * after the reasoning had already collapsed, a second jump where one belongs
 * (stream audit 2026-09, defect 4). A rewrite of text already shown (the
 * settled snapshot renumbering a marker) is a correction, not new text: it
 * keeps the length that was shown and paces only what lies beyond it
 * (`keepThroughRewrite`). It used to fall back to the first changed character
 * and type the answer out again (defect 1).
 *
 * Pure, so the rules are testable without timers: `advancePace` takes the
 * state, what has arrived and how long since the last tick, and returns the
 * next state.
 */

/** How far behind the arrivals the reveal aims to sit. */
export const TARGET_LAG_MS = 450
/** The most the reveal may hold back: past this it catches up at once. */
export const MAX_LAG_MS = 1200
/** The slowest the reveal goes while there is anything to show, in characters per second. */
export const MIN_CHARS_PER_SECOND = 45
/** How often the reveal steps, in ms. Coarse on purpose: every step re-parses the answer. */
export const PACE_TICK_MS = 50

export interface PaceState {
  /** How many characters of the arrived text are shown. */
  shown: number
  /** Characters the rate has granted that no clean cut has used yet. */
  credit: number
  /**
   * Arrival lengths the store delivered, oldest first. Not clean cuts: a delta
   * can end inside a bold phrase. They only carry the ceiling: text that has
   * waited `MAX_LAG_MS` is shown whether or not it ends cleanly.
   */
  arrivals: number[]
  /** When each arrival in `arrivals` came, in ms (same clock as `now`). */
  arrivedAt: number[]
}

export const initialPace = (length: number): PaceState => ({
  shown: length,
  credit: 0,
  arrivals: [],
  arrivedAt: [],
})

/**
 * Could the renderer draw `text` as it stands, without a construct left open?
 * An open one would flash as raw markdown until its closing half arrived: a
 * `**` with no partner, a link with no `)`, a code span, a fence, half a
 * table row. Deliberately conservative: a cut it refuses only waits for the
 * next one.
 */
export function isCleanCut(text: string): boolean {
  const fences = text.match(/^\s*(```|~~~)/gm)?.length ?? 0
  if (fences % 2 === 1) return false
  const lineStart = text.lastIndexOf('\n') + 1
  const line = text.slice(lineStart)
  // A table row is drawn a whole row at a time.
  if (/^\s*\|/.test(line)) return false
  if ((line.match(/`/g)?.length ?? 0) % 2 === 1) return false
  if ((line.match(/\*\*/g)?.length ?? 0) % 2 === 1) return false
  if ((line.match(/\[/g)?.length ?? 0) !== (line.match(/\]/g)?.length ?? 0)) return false
  if ((line.match(/\(/g)?.length ?? 0) > (line.match(/\)/g)?.length ?? 0)) return false
  return true
}

/** Is `i` a word gap: just after a space or a line break, so no word is split? */
const isWordGap = (text: string, i: number): boolean => text[i - 1] === ' ' || text[i - 1] === '\n'

/** The furthest word gap in `text` after `from` and at or before `limit` that `isCleanCut` accepts; `from` when there is none. */
export function furthestCleanCut(text: string, from: number, limit: number): number {
  for (let i = Math.min(limit, text.length); i > from; i--) {
    if (isWordGap(text, i) && isCleanCut(text.slice(0, i))) return i
  }
  return from
}

/** The nearest word gap in `text` after `from` that `isCleanCut` accepts; `undefined` when there is none yet. */
export function nextCleanCut(text: string, from: number): number | undefined {
  for (let i = from + 1; i <= text.length; i++) {
    if (isWordGap(text, i) && isCleanCut(text.slice(0, i))) return i
  }
  return undefined
}

/**
 * Where a rewrite of the text leaves the reveal: at the length that was
 * shown, moved on to the next clean cut if that length is not one, never
 * back. `text` is the replacement, `shown` how much of the previous text was
 * on screen.
 */
export function keepThroughRewrite(text: string, shown: number): number {
  const keep = Math.min(shown, text.length)
  if (keep === text.length || keep === 0) return keep
  if (isWordGap(text, keep) && isCleanCut(text.slice(0, keep))) return keep
  return nextCleanCut(text, keep) ?? text.length
}

/** Record a new arrival: the text grew to `length` at `now`. */
export function noteArrival(state: PaceState, length: number, now: number): PaceState {
  if (length <= (state.arrivals.at(-1) ?? state.shown)) return state
  return { ...state, arrivals: [...state.arrivals, length], arrivedAt: [...state.arrivedAt, now] }
}

/**
 * One step of the reveal of a streaming answer.
 *
 * The rate is what empties the backlog in `TARGET_LAG_MS`, never slower than
 * `MIN_CHARS_PER_SECOND`, so a burst is paid out steadily and a trickle keeps
 * up. The first clean cut is shown at once: the target lag is for smoothing
 * text that is already moving, not for holding back the first words. Text
 * that has waited `MAX_LAG_MS` is shown whatever the rate says, clean or not.
 */
export function advancePace(state: PaceState, text: string, elapsedMs: number, now: number): PaceState {
  const length = text.length
  if (state.shown >= length) return { ...state, shown: length, credit: 0, arrivals: [], arrivedAt: [] }

  const backlog = length - state.shown
  const perSecond = Math.max(MIN_CHARS_PER_SECOND, (backlog * 1000) / TARGET_LAG_MS)
  const credit = state.credit + (perSecond * elapsedMs) / 1000
  const limit = Math.min(length, state.shown + Math.floor(credit))

  // Whatever arrived longer ago than the ceiling is due now.
  let due = state.shown
  state.arrivals.forEach((boundary, i) => {
    if (now - (state.arrivedAt[i] ?? now) >= MAX_LAG_MS) due = Math.max(due, boundary)
  })

  const first = state.shown === 0 ? (nextCleanCut(text, 0) ?? 0) : 0
  const cut = Math.max(due, first, furthestCleanCut(text, state.shown, limit))
  const shown = Math.min(length, cut)
  const keep = state.arrivals.map((b, i) => [b, state.arrivedAt[i] ?? now] as const).filter(([b]) => b > shown)
  return {
    shown,
    // What the cut did not use carries over, but never more than one tick's worth
    // of catching up: a long wait for a clean cut must not become a lurch.
    credit: Math.max(0, Math.min(credit - (shown - state.shown), perSecond * (PACE_TICK_MS / 1000) * 4)),
    arrivals: keep.map(([b]) => b),
    arrivedAt: keep.map(([, t]) => t),
  }
}
