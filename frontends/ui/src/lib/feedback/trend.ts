/**
 * The daily feedback series, and the one number derived from it: is this getting
 * better?
 *
 * Shared between the chart (`features/platform/components/feedback-trend`) and
 * the digest (`lib/feedback/digest`) on purpose. Both make the same claim in
 * different words — a line with "3.4 points better" over it, and a sentence
 * saying the helpful rate improved — and two implementations of that claim would
 * eventually contradict each other on the same screen. Neither imports the
 * repository, so this file stays usable on the client.
 *
 * **The series is the HELPFUL rate, not the negative one.** Same data, and not
 * the same reading: on a negative-rate chart the good direction is down, which
 * every reader has to translate before the shape means anything, and the label
 * "3 points better" sat on a line that had just fallen. Up is better here.
 */

export interface FeedbackDayPoint {
  day: string
  up: number
  down: number
}

export interface FeedbackTrendDay {
  day: string
  total: number
  up: number
  /**
   * Share of the day's votes that were helpful, or `null` when the day had too
   * few votes to be a reading. Null is not zero: zero is a measurement.
   */
  rate: number | null
}

/**
 * Below this many votes in a day, a percentage is noise. One down-vote out of
 * two is 50% and would spike a line into something that looks like a collapse.
 */
export const MIN_TREND_VOTES = 5

/**
 * Fill the window day by day, oldest first.
 *
 * The server returns only days that HAD votes, and plotting those against an
 * evenly spaced axis silently compresses quiet periods — a fortnight of silence
 * renders as one step.
 *
 * `now` is injectable so a test can pin the window instead of racing midnight.
 */
export function fillTrendWindow(
  points: readonly FeedbackDayPoint[],
  windowDays: number,
  minVotes: number = MIN_TREND_VOTES,
  now: Date = new Date(),
): FeedbackTrendDay[] {
  const byDay = new Map(points.map((p) => [p.day, p]))
  const out: FeedbackTrendDay[] = []
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const date = new Date(now)
    date.setUTCDate(date.getUTCDate() - i)
    const key = date.toISOString().slice(0, 10)
    const found = byDay.get(key)
    const up = found?.up ?? 0
    const total = found ? found.up + found.down : 0
    out.push({
      day: key,
      total,
      up,
      rate: total >= minVotes ? (up / total) * 100 : null,
    })
  }
  return out
}

/**
 * The direction, in percentage points of the helpful rate. Positive = improving.
 *
 * Measured as the first third of readable days against the last third — NOT the
 * first point against the last. Endpoints are single days, so a quiet Friday at
 * one end swings the verdict by a dozen points and the claim about whether the
 * product is improving becomes noise. That is the same small-sample trap the
 * rest of this surface guards against; measuring it differently here would be
 * incoherent.
 *
 * `null` when fewer than two days are readable — "we do not know yet" is a
 * different statement from "flat", and only one of them is honest.
 */
export function feedbackTrendDelta(days: readonly FeedbackTrendDay[]): number | null {
  const readable = days.filter((d) => d.rate !== null)
  if (readable.length < 2) return null
  const third = Math.max(1, Math.floor(readable.length / 3))
  const mean = (window: readonly FeedbackTrendDay[]): number =>
    window.reduce((sum, d) => sum + (d.rate ?? 0), 0) / window.length
  return mean(readable.slice(-third)) - mean(readable.slice(0, third))
}

/** Mean helpful rate across the readable days of the window. */
export function feedbackTrendAverage(days: readonly FeedbackTrendDay[]): number {
  const readable = days.filter((d) => d.rate !== null)
  if (readable.length === 0) return 0
  return readable.reduce((sum, d) => sum + (d.rate ?? 0), 0) / readable.length
}
