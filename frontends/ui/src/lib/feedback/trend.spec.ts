import { describe, expect, it } from 'vitest'

import { feedbackTrendAverage, feedbackTrendDelta, fillTrendWindow } from './trend'

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
  it('averages only the readable days', () => {
    const points = [
      { day: day(2), up: 8, down: 2 },
      // Thin day: excluded, rather than dragged in at 0%.
      { day: day(1), up: 0, down: 1 },
      { day: day(0), up: 6, down: 4 },
    ]
    expect(feedbackTrendAverage(fillTrendWindow(points, 3, 5, NOW))).toBe(70)
  })
})
