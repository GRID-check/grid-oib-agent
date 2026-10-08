/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { feedbackTrendAverage, feedbackTrendDelta, feedbackWindowStart, fillTrendWindow } from './trend'

/** Pinned, so the window does not move under the test at midnight. */
const NOW = new Date('2026-07-30T12:00:00Z')
const day = (n: number): string => {
  const d = new Date(NOW)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

describe('fillTrendWindow', () => {
  it('emits one entry per day of the window, oldest first', () => {
    const days = fillTrendWindow([{ day: day(1), up: 8, down: 2 }], 5, 5, NOW)

    expect(days).toHaveLength(5)
    expect(days[0].day).toBe(day(4))
    expect(days.at(-1)!.day).toBe(day(0))
  })

  /**
   * The server returns only days that HAD votes. Plotting those alone against an
   * evenly spaced axis compresses quiet periods — a fortnight of silence renders
   * as one step, which is a different chart from the truth.
   */
  it('keeps silent days as silent rather than closing the gap', () => {
    const days = fillTrendWindow([{ day: day(3), up: 8, down: 2 }], 5, 5, NOW)

    const silent = days.filter((d) => d.total === 0)
    expect(silent).toHaveLength(4)
    expect(silent.every((d) => d.rate === null)).toBe(true)
  })

  it('reads the HELPFUL share, so a good day is a high number', () => {
    const [only] = fillTrendWindow([{ day: day(0), up: 9, down: 1 }], 1, 5, NOW)
    expect(only.rate).toBe(90)
  })

  /**
   * A day of one vote is 0% or 100%, and both look like verdicts. Null is not
   * zero: zero is a measurement, null is an admission.
   */
  it('refuses a rate for a day below the vote floor', () => {
    const [only] = fillTrendWindow([{ day: day(0), up: 1, down: 1 }], 1, 5, NOW)
    expect(only.rate).toBeNull()
    expect(only.total).toBe(2)
  })
})

describe('feedbackTrendDelta', () => {
  it('is positive when the helpful rate rose', () => {
    const points = [
      ...[6, 6, 6].map((n, i) => ({ day: day(8 - i), up: 10 - n, down: n })),
      ...[2, 1, 2].map((n, i) => ({ day: day(2 - i), up: 10 - n, down: n })),
    ]
    const delta = feedbackTrendDelta(fillTrendWindow(points, 9, 5, NOW))

    expect(delta).not.toBeNull()
    expect(delta!).toBeGreaterThan(0)
  })

  /**
   * The endpoint trap. Comparing the first and last DAY makes the verdict hostage
   * to two single days; the rest of this surface suppresses small-sample readings
   * everywhere, so the direction has to be measured the same way.
   */
  it('measures thirds, so one bad final day cannot flip the verdict', () => {
    const points = [
      ...[9, 8, 7, 6].map((n, i) => ({ day: day(9 - i), up: 10 - n, down: n })),
      ...[3, 2, 3, 2].map((n, i) => ({ day: day(4 - i), up: 10 - n, down: n })),
      { day: day(0), up: 2, down: 8 },
    ]
    const delta = feedbackTrendDelta(fillTrendWindow(points, 10, 5, NOW))

    expect(delta!).toBeGreaterThan(0)
  })

  it('returns null rather than "flat" when it cannot see a direction', () => {
    // "We do not know yet" and "nothing changed" are different statements, and
    // only one of them is honest here.
    expect(feedbackTrendDelta(fillTrendWindow([{ day: day(0), up: 9, down: 1 }], 7, 5, NOW))).toBeNull()
  })
})

describe('feedbackTrendAverage', () => {
  /**
   * The headline is pooled: every helpful vote over every vote. A mean of daily
   * rates weighs a 2-vote day like a 40-vote one, and the line's label then
   * disagrees with the number above it.
   */
  it('pools every vote in the window, so it equals the headline rate', () => {
    const points = [
      { day: day(2), up: 36, down: 4 }, // 90 %, 40 votes
      { day: day(1), up: 0, down: 2 }, // thin: counts for its two votes, no more
      { day: day(0), up: 3, down: 2 }, // 60 %, 5 votes
    ]
    // Pooled: 39 / 47. The old unweighted mean of readable days said 75.
    expect(feedbackTrendAverage(fillTrendWindow(points, 3, 5, NOW))).toBeCloseTo((39 / 47) * 100, 6)
  })

  it('is 0 for a window with no votes', () => {
    expect(feedbackTrendAverage(fillTrendWindow([], 3, 5, NOW))).toBe(0)
  })
})

describe('feedbackTrendDelta, weighted', () => {
  /**
   * Early third: a 100-vote day at 50 % and a 5-vote day at 100 %. Unweighted
   * that third reads 75 %; pooled it reads 52.4 %. Late third: 60 %. The
   * unweighted delta says "15 points worse"; the votes say "7.6 points better".
   */
  it('weights each third by its votes, so a thin day cannot reverse the direction', () => {
    const points = [
      { day: day(5), up: 50, down: 50 },
      { day: day(4), up: 5, down: 0 },
      { day: day(3), up: 6, down: 4 },
      { day: day(2), up: 6, down: 4 },
      { day: day(1), up: 30, down: 20 },
      { day: day(0), up: 30, down: 20 },
    ]
    const delta = feedbackTrendDelta(fillTrendWindow(points, 6, 5, NOW))

    expect(delta).toBeCloseTo(60 - (55 / 105) * 100, 6)
  })
})

describe('feedbackWindowStart', () => {
  it('starts at UTC midnight of the oldest day the chart draws', () => {
    const start = feedbackWindowStart(7, NOW)
    expect(start.toISOString()).toBe(`${day(6)}T00:00:00.000Z`)
    expect(fillTrendWindow([], 7, 5, NOW)[0].day).toBe(start.toISOString().slice(0, 10))
  })

  it('is today at midnight for a one-day window, never mid-day', () => {
    expect(feedbackWindowStart(1, NOW).toISOString()).toBe('2026-07-30T00:00:00.000Z')
  })
})
