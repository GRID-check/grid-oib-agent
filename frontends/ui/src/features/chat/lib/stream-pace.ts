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
 * Pure, so the rules are testable without timers: `advancePace` takes the
 * state, what has arrived, how long since the last tick and whether the turn
 * is still streaming, and returns the next state.
 */

/** How far behind the arrivals the reveal aims to sit. */
export const TARGET_LAG_MS = 450
/** The most the reveal may hold back: past this it catches up at once. */
export const MAX_LAG_MS = 1200
/** The slowest the reveal goes while there is anything to show, in characters per second. */
export const MIN_CHARS_PER_SECOND = 45
/** Once the turn has ended, whatever is left is shown within about this long. */
export const DRAIN_MS = 250
/** How often the reveal steps, in ms. Coarse on purpose: every step re-parses the answer. */
export const PACE_TICK_MS = 50

export interface PaceState {
  /** How many characters of the arrived text are shown. */
  shown: number
  /** Characters the rate has granted that no clean cut has used yet. */
  credit: number
  /** Arrival lengths the store delivered, oldest first: clean cuts by construction. */
  arrivals: number[]
  /** When each arrival in `arrivals` came, in ms (same clock as `now`). */
  arrivedAt: number[]
  /**
   * The rate the rest drains at once the turn has ended, fixed when it ends:
   * a rate recomputed from a shrinking remainder never finishes.
   */
  drainPerSecond?: number
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

/**
 * The furthest clean cut in `text` after `from` and at or before `limit`:
 * an arrival boundary, or a word gap `isCleanCut` accepts. `from` when there
 * is none.
 */
export function furthestCleanCut(text: string, from: number, limit: number, arrivals: readonly number[]): number {
  let best = from
  for (const boundary of arrivals) if (boundary > best && boundary <= limit) best = boundary
  for (let i = Math.min(limit, text.length); i > best; i--) {
    // A cut sits just after a space or a line break, so a word is never split.
    const previous = text[i - 1]
    if (previous !== ' ' && previous !== '\n') continue
    if (isCleanCut(text.slice(0, i))) return i
  }
  return best
}

/** Record a new arrival: the text grew to `length` at `now`. */
export function noteArrival(state: PaceState, length: number, now: number): PaceState {
  if (length <= (state.arrivals.at(-1) ?? state.shown)) return state
  return { ...state, arrivals: [...state.arrivals, length], arrivedAt: [...state.arrivedAt, now] }
}

/**
 * One step of the reveal.
 *
 * The rate is what empties the backlog in `TARGET_LAG_MS`, never slower than
 * `MIN_CHARS_PER_SECOND`, so a burst is paid out steadily and a trickle keeps
 * up. Text that has waited `MAX_LAG_MS` is shown whatever the rate says.
 * After the turn ends the rest drains within `DRAIN_MS`.
 */
export function advancePace(
  state: PaceState,
  text: string,
  elapsedMs: number,
  now: number,
  streaming: boolean
): PaceState {
  const length = text.length
  if (state.shown >= length) return { ...state, shown: length, credit: 0, arrivals: [], arrivedAt: [] }

  const backlog = length - state.shown
  const drainPerSecond = streaming ? undefined : (state.drainPerSecond ?? (backlog * 1000) / DRAIN_MS)
  const perSecond = Math.max(MIN_CHARS_PER_SECOND, drainPerSecond ?? (backlog * 1000) / TARGET_LAG_MS)
  const credit = state.credit + (perSecond * elapsedMs) / 1000
  const limit = Math.min(length, state.shown + Math.floor(credit))

  // Whatever arrived longer ago than the ceiling is due now.
  let due = state.shown
  state.arrivals.forEach((boundary, i) => {
    if (now - (state.arrivedAt[i] ?? now) >= MAX_LAG_MS) due = Math.max(due, boundary)
  })

  // A finished turn's text is whole: its end is a clean cut.
  const end = !streaming && limit >= length ? length : 0
  const cut = Math.max(due, end, furthestCleanCut(text, state.shown, limit, state.arrivals))
  const shown = Math.min(length, cut)
  const keep = state.arrivals.map((b, i) => [b, state.arrivedAt[i] ?? now] as const).filter(([b]) => b > shown)
  return {
    shown,
    // What the cut did not use carries over, but never more than one tick's worth
    // of catching up: a long wait for a clean cut must not become a lurch.
    credit: Math.max(0, Math.min(credit - (shown - state.shown), perSecond * (PACE_TICK_MS / 1000) * 4)),
    arrivals: keep.map(([b]) => b),
    arrivedAt: keep.map(([, t]) => t),
    ...(drainPerSecond === undefined ? {} : { drainPerSecond }),
  }
}

/** How many leading characters `a` and `b` share. */
export function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}
