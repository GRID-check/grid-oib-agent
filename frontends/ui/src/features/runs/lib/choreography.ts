/**
 * The run block's landing — when each move starts, in seconds after the
 * ledger's status changed.
 *
 * A status change is one render, and every element that reacts to it would
 * otherwise move at once: the last check, the header glyph, the bold word, the
 * fold, the sentence beneath, the report. Watched together they are a flicker;
 * watched in order they tell the story of a run ending. So the moves are
 * queued, each starting when the previous one ends, and this file is the
 * queue. Every offset is a sum of the motion kit's own numbers — nothing here
 * is a duration somebody chose for this block, so a retune of the scale moves
 * the whole sequence with it.
 *
 * The sequence, for a run that lands `fertig`:
 *
 *   0                    the last swatch's check draws in (springSnap)
 *   check settled        the spinner leaves, the check pops in (snap, twice)
 *   + glyph              the status word crossfades (quick, twice)
 *   + word + deliberate  the body folds, unless the reader holds it open
 *   + fold's exit        the sentence and the file link rise
 *   + two stagger steps  the report beneath the block rises
 *
 * Every other status has no check to wait for, so its glyph swaps at once and
 * the rest follows at the same spacing. `wartet` folds nothing — the body is
 * forced open, because the sentence telling the reader what to do is inside it
 * — so its footer follows the word directly.
 */

import {
  motionDeliberate,
  motionQuick,
  motionQuickExit,
  motionSnap,
  springSnapSettleSeconds,
  staggerStepSeconds,
} from '@/components/motion'
import { isTerminalRunStatus, type RunStatus } from '@/lib/runs/run-ledger-types'

export interface LandingDelays {
  /** The header glyph swaps: the old one starts leaving now. */
  glyph: number
  /** The status word crossfades: the old word starts leaving now. */
  word: number
  /** The body folds, when the block opened itself. `null`: it stays. */
  fold: number | null
  /** The footer — the sentence and the affordances — rises. */
  footer: number
  /** The report the message renders beneath the block rises. */
  report: number
}

/** A `Transition`'s duration as a number; the kit's tweens all carry one. */
const seconds = (duration: number | undefined): number => duration ?? 0

/** The glyph swap takes two snaps: one out, one in (`AnimatePresence mode="wait"`). */
const GLYPH_SWAP = 2 * seconds(motionSnap.duration)
/** The word crossfade takes two quicks, for the same reason. */
const WORD_SWAP = 2 * seconds(motionQuick.duration)

/**
 * When each move starts after the block's status became `status`.
 *
 * `fertig` waits for the rail's last check to settle before touching the
 * header, so the eye that watched the rail finish is led up to the verdict
 * rather than pulled two ways. Nothing else on the rail moves on the other
 * landings — a failed run's live phase keeps its ring — so they start at once.
 */
export function landingDelays(status: RunStatus): LandingDelays {
  const glyph = status === 'fertig' ? springSnapSettleSeconds : 0
  const word = glyph + GLYPH_SWAP
  const wordDone = word + WORD_SWAP
  const fold = isTerminalRunStatus(status) ? wordDone + seconds(motionDeliberate.duration) : null
  const footer = fold === null ? wordDone : fold + seconds(motionQuickExit.duration)
  const report = footer + 2 * staggerStepSeconds
  return { glyph, word, fold, footer, report }
}
