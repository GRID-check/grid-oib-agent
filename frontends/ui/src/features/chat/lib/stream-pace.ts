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
 * When the turn ends, what is still held back is not dumped at once: it is
 * finished quickly (`finishCut`, 300–500 ms), and only then does the answer
 * settle (the caret goes, the footer and the unplaced cards come, the
 * Herleitung collapses), all in one frame. Dumping it was a visible jump once
 * the reveal held back more than a beat. Pacing the terminal at the streaming
 * rate made the answer drain after the reasoning had already collapsed, a
 * second jump where one belongs (stream audit 2026-09, defect 4); the finish
 * is short, and nothing settles until it is done. A rewrite of text already
 * shown (the settled snapshot renumbering a marker) is a correction, not new
 * text: it keeps the length that was shown and paces only what lies beyond it
 * (`keepThroughRewrite`). It used to fall back to the first changed character
 * and type the answer out again (defect 1).
 *
 * Pure, so the rules are testable without timers: `advancePace` takes the
 * state, what has arrived and how long since the last step, and returns the
 * next state.
 */

import { isDelimiterRow } from '@/lib/text/markdown-table'

/**
 * How far behind the arrivals the reveal aims to sit. Long enough that the
 * bursts the model and the store batching deliver (a sentence, then half a
 * second of nothing) are paid out at one steady rate instead of the reveal
 * speeding up and stalling, which is what gives the word fade room to read.
 */
export const TARGET_LAG_MS = 1200
/** The most the reveal may hold back: past this it catches up at once. */
export const MAX_LAG_MS = 2500
/** The slowest the reveal goes while there is anything to show, in characters per second. */
export const MIN_CHARS_PER_SECOND = 45
/** The most unused rate one step carries to the next, in ms at the current rate. */
const CREDIT_CAP_MS = 200
/** The finish of a turn's held-back text takes at least this long… */
export const FINISH_MIN_MS = 300
/** …and at most this long, however much is left. */
export const FINISH_MAX_MS = 500
/** Between the two, each character left adds this much. */
const FINISH_MS_PER_CHAR = 0.5

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
 * link with no `)`, a code span, a fence, a table cell. An open `**` on the
 * last line is not one (the streaming renderer closes it), and a table row
 * may end after any finished cell. Deliberately conservative: a cut it
 * refuses only waits for the next one.
 */
export function isCleanCut(text: string): boolean {
  const fences = text.match(/^\s*(```|~~~)/gm)?.length ?? 0
  if (fences % 2 === 1) return false
  const lineStart = text.lastIndexOf('\n') + 1
  const line = text.slice(lineStart)
  // A table row may end after a finished cell, once the table has its
  // delimiter row: GFM pads a short row with empty cells, so the row appears
  // and fills cell by cell. Holding it until it was whole stalled the reveal
  // 0.5–1 s per row and then dropped 170–260 characters at once (stream
  // audit, 2026-09). But a row with no cell written yet (`| `) is not one: it
  // drew as a blank row whose cells then grew one by one as their words came,
  // each step pushing everything below it down (a stacked row on a phone grew
  // 64 → 84 → 87 → 90 px, stream audit 2026-10). The row appears with its
  // first cell.
  if (/^\s*\|/.test(line)) return /\|\s*$/.test(line) && /[^|\s]/.test(line) && tableHasDelimiter(text, lineStart)
  // Just past a table line, on a new one: clean only once the table has its
  // delimiter row. Before it, the header line renders as a paragraph of
  // pipes (`stabilizeStreamingMarkdown` escapes it) until the delimiter
  // arrives and it turns into a table, the one moment raw markdown showed.
  // Nor just past the delimiter row itself: a table of its header alone is
  // drawn as a table for a frame and, on a phone, restacked into rows (the
  // header hidden) as soon as its first row comes. It appears with that row.
  if (line === '' && lineStart > 0 && /^\s*\|/.test(lineBefore(text, lineStart))) {
    return tableHasDelimiter(text, lineStart) && !isDelimiterRow(lineBefore(text, lineStart))
  }
  if ((line.match(/`/g)?.length ?? 0) % 2 === 1) return false
  // An open `**` is fine: the renderer closes it while the answer streams
  // (`stabilizeStreamingMarkdown`), so the phrase is bold from its first word.
  if ((line.match(/\[/g)?.length ?? 0) !== (line.match(/\]/g)?.length ?? 0)) return false
  if ((line.match(/\(/g)?.length ?? 0) > (line.match(/\)/g)?.length ?? 0)) return false
  return true
}

/** The line that ends just before `lineStart`. */
const lineBefore = (text: string, lineStart: number): string =>
  text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1)

/** Do the table lines above `lineStart` include the delimiter row (`| --- |`)? */
function tableHasDelimiter(text: string, lineStart: number): boolean {
  let end = lineStart - 1
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end)
    if (!/^\s*\|/.test(line)) return false
    if (isDelimiterRow(line)) return true
    end = start - 1
  }
  return false
}

/** Is `i` a word gap: just after a space or a line break, so no word is split? */
const isWordGap = (text: string, i: number): boolean => text[i - 1] === ' ' || text[i - 1] === '\n'

/**
 * Every word gap in `text` after `from` that `isCleanCut` accepts, nearest
 * first, found in ONE forward walk.
 *
 * `isCleanCut` reads the whole prefix (its fence count), so asking it at
 * every position was quadratic: inside an open fence no position is clean,
 * and the search walked to the end of the text re-reading all of it per
 * character (6.9 ms a frame on a desktop for 3.5k of prose ahead of an open
 * 4k mermaid fence, review 2026-10). This walk keeps what `isCleanCut` reads
 * as running counts instead: the fences above the line, and the line's own
 * backticks, brackets and parentheses. `isCleanCut` stays the definition; the
 * spec holds this walk to it position by position.
 */
function* cleanCutsAfter(text: string, from: number): Generator<number> {
  let lineStart = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1
  let fencesAbove = text.slice(0, lineStart).match(/^\s*(```|~~~)/gm)?.length ?? 0
  let line = new LineScan(text, lineStart)
  for (let i = lineStart; i <= text.length; i++) {
    if (i > lineStart) {
      const char = text[i - 1]
      if (char === '\n') {
        if (line.fence) fencesAbove++
        lineStart = i
        line = new LineScan(text, lineStart)
      } else line.add(char, i - 1)
    }
    if (i > from && isWordGap(text, i) && line.isClean(fencesAbove)) yield i
  }
}

/** What `isCleanCut` reads off the last line of a prefix, kept as the line grows. */
class LineScan {
  /** Does the line open (or close) a fence, as `^\s*(```|~~~)` reads it? */
  fence = false
  private length = 0
  private firstSolid = -1
  private lastSolid = ''
  private hasCellText = false
  private backticks = 0
  private brackets = 0
  private unclosedParens = 0
  private delimiterAbove: boolean | undefined

  constructor(
    private readonly text: string,
    private readonly start: number
  ) {}

  /** The line grew by `char`, which sits at `at` in the text. */
  add(char: string, at: number): void {
    this.length++
    if (!/\s/.test(char)) {
      if (this.firstSolid < 0) this.firstSolid = at
      this.lastSolid = char
      if (char !== '|') this.hasCellText = true
    }
    if (this.firstSolid >= 0 && at === this.firstSolid + 2) {
      const opening = this.text.slice(this.firstSolid, at + 1)
      this.fence = opening === '```' || opening === '~~~'
    }
    if (char === '`') this.backticks++
    else if (char === '[') this.brackets++
    else if (char === ']') this.brackets--
    else if (char === '(') this.unclosedParens++
    else if (char === ')') this.unclosedParens--
  }

  /** `isCleanCut` of the prefix ending here, its rules in its order, `fencesAbove` the fence lines above this one. */
  isClean(fencesAbove: number): boolean {
    if ((fencesAbove + (this.fence ? 1 : 0)) % 2 === 1) return false
    const { text, start } = this
    if (this.firstSolid >= 0 && text[this.firstSolid] === '|') {
      return this.lastSolid === '|' && this.hasCellText && this.hasDelimiter()
    }
    if (this.length === 0 && start > 0 && /^\s*\|/.test(lineBefore(text, start))) {
      return this.hasDelimiter() && !isDelimiterRow(lineBefore(text, start))
    }
    if (this.backticks % 2 === 1) return false
    if (this.brackets !== 0) return false
    return this.unclosedParens <= 0
  }

  private hasDelimiter(): boolean {
    this.delimiterAbove ??= tableHasDelimiter(this.text, this.start)
    return this.delimiterAbove
  }
}

/** The furthest word gap in `text` after `from` and at or before `limit` that `isCleanCut` accepts; `from` when there is none. */
export function furthestCleanCut(text: string, from: number, limit: number): number {
  const end = Math.min(limit, text.length)
  let furthest = from
  for (const cut of cleanCutsAfter(text, from)) {
    if (cut > end) break
    furthest = cut
  }
  return furthest
}

/** The nearest word gap in `text` after `from` that `isCleanCut` accepts; `undefined` when there is none yet. */
export function nextCleanCut(text: string, from: number): number | undefined {
  for (const cut of cleanCutsAfter(text, from)) return cut
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

/** The two numbers the reveal is tuned by; the defaults are the shipped ones. */
export interface PaceTuning {
  targetLagMs?: number
  maxLagMs?: number
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
export function advancePace(
  state: PaceState,
  text: string,
  elapsedMs: number,
  now: number,
  { targetLagMs = TARGET_LAG_MS, maxLagMs = MAX_LAG_MS }: PaceTuning = {}
): PaceState {
  const length = text.length
  if (state.shown >= length) return { ...state, shown: length, credit: 0, arrivals: [], arrivedAt: [] }

  const backlog = length - state.shown
  const perSecond = Math.max(MIN_CHARS_PER_SECOND, (backlog * 1000) / targetLagMs)
  const credit = state.credit + (perSecond * elapsedMs) / 1000
  const limit = Math.min(length, state.shown + Math.floor(credit))

  // Whatever arrived longer ago than the ceiling is due now.
  let due = state.shown
  state.arrivals.forEach((boundary, i) => {
    if (now - (state.arrivedAt[i] ?? now) >= maxLagMs) due = Math.max(due, boundary)
  })

  const first = state.shown === 0 ? (nextCleanCut(text, 0) ?? 0) : 0
  const cut = Math.max(due, first, furthestCleanCut(text, state.shown, limit))
  const shown = Math.min(length, cut)
  const keep = state.arrivals.map((b, i) => [b, state.arrivedAt[i] ?? now] as const).filter(([b]) => b > shown)
  // What the cut did not use carries over, but never more than a moment's
  // worth of catching up, so a long wait for a clean cut does not become a
  // lurch. Always enough to reach the next word, though: at a slow rate a
  // moment is fewer characters than „erforderlich, " has, and a cap below the
  // next word stalls the reveal until the ceiling dumps the text.
  const nextWord = shown < length ? (nextCleanCut(text, shown) ?? length) - shown : 0
  const cap = Math.max((perSecond * CREDIT_CAP_MS) / 1000, nextWord)
  return {
    shown,
    credit: Math.max(0, Math.min(credit - (shown - state.shown), cap)),
    arrivals: keep.map(([b]) => b),
    arrivedAt: keep.map(([, t]) => t),
  }
}

/** How long the finish of `remaining` held-back characters takes. */
export const finishDuration = (remaining: number): number =>
  Math.min(FINISH_MAX_MS, Math.max(FINISH_MIN_MS, FINISH_MIN_MS + remaining * FINISH_MS_PER_CHAR))

/**
 * Where the finish of a turn stands `elapsedMs` into it: the text was shown up
 * to `from` when the turn ended, and the rest is revealed over `durationMs`,
 * fast at first and easing into the end, cut at clean word gaps. At the end
 * it is the whole text.
 */
export function finishCut(text: string, from: number, shown: number, elapsedMs: number, durationMs: number): number {
  if (elapsedMs >= durationMs) return text.length
  const progress = 1 - (1 - elapsedMs / durationMs) ** 2
  const target = from + Math.floor((text.length - from) * progress)
  return Math.max(shown, furthestCleanCut(text, shown, target))
}
