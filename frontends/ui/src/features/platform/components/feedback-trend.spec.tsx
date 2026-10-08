import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'

import { FeedbackTrend, FeedbackTrendDirection } from './feedback-trend'

/** N days back from today, which is what `fillWindow` anchors on. */
const dayAgo = (n: number): string => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

describe('FeedbackTrend', () => {
  it('plots the RATE, so a busy day is not mistaken for a bad one', () => {
    // Day A: 2 down of 20 (10%). Day B: 3 down of 10 (30%). B has FEWER
    // down-votes in absolute terms and is the worse day — a count series would
    // rank them the other way round.
    const points = [
      { day: dayAgo(2), up: 18, down: 2 },
      { day: dayAgo(0), up: 7, down: 3 },
    ]
    render(
      <>
        <FeedbackTrend windowDays={3} points={points} />
        <FeedbackTrendDirection windowDays={3} points={points} />
      </>
    )

    expect(screen.getByTestId('feedback-trend')).toBeInTheDocument()
    // 10% → 30% is a worsening, even though day B has one more down-vote only.
    expect(screen.getByTestId('feedback-trend-delta')).toHaveTextContent(/worse/i)
  })

  it('refuses to report a direction it cannot see', () => {
    render(
      <>
        <FeedbackTrend windowDays={7} points={[{ day: dayAgo(1), up: 1, down: 1 }]} />
        <FeedbackTrendDirection windowDays={7} points={[{ day: dayAgo(1), up: 1, down: 1 }]} />
      </>
    )

    // One day, and a thin one. A flat line at zero here would read as "perfect"
    // rather than "unknown".
    expect(screen.getByTestId('feedback-trend-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('feedback-trend')).toBeNull()
    // …and no direction badge claiming one.
    expect(screen.queryByTestId('feedback-trend-delta')).toBeNull()
  })

  /**
   * The endpoint trap. Comparing the first and last DAY makes the verdict hostage
   * to two single days; this page suppresses small-sample rates everywhere else,
   * so the direction has to be measured the same way.
   */
  it('measures direction over thirds, not over the two end days', () => {
    const points = [
      // A stable, clearly improving body…
      ...[9, 8, 7, 6].map((n, i) => ({ day: dayAgo(9 - i), up: 10 - n, down: n })),
      ...[3, 2, 3, 2].map((n, i) => ({ day: dayAgo(4 - i), up: 10 - n, down: n })),
      // …ending on one bad day that a first-vs-last reading would let dominate.
      { day: dayAgo(0), up: 2, down: 8 },
    ]
    render(<FeedbackTrendDirection windowDays={10} points={points} />)

    // Despite the final day being the worst in the window, the window improved.
    expect(screen.getByTestId('feedback-trend-delta')).toHaveTextContent(/better/i)
  })

  it('treats a thin day as unknown rather than as a spike', () => {
    const points = [
      ...[5, 5, 5].map((n, i) => ({ day: dayAgo(5 - i), up: 15, down: n })),
      // 1 of 1 is 100% and would be the tallest point on the chart.
      { day: dayAgo(1), up: 0, down: 1 },
      { day: dayAgo(0), up: 16, down: 4 },
    ]
    render(<FeedbackTrend windowDays={6} points={points} minVotes={5} />)

    // The chart renders, and the thin day contributes no marker to it: 5 readable
    // days in, 5 circles out.
    const svg = screen.getByRole('img')
    expect(svg.querySelectorAll('circle')).toHaveLength(4)
  })

  /**
   * Bug: the plot was a fixed 720-unit viewBox stretched with
   * `preserveAspectRatio="none"`, so on any other width the dots drew as
   * ellipses and the SVG axis text was squashed or stretched. The plot now
   * keeps its aspect and the scale is HTML.
   */
  it('draws without stretching: no squashed SVG text, aspect kept', () => {
    const points = [0, 1, 2].map((n) => ({ day: dayAgo(n), up: 8, down: 2 }))
    render(<FeedbackTrend windowDays={3} points={points} />)

    const svg = screen.getByRole('img')
    expect(svg.getAttribute('preserveAspectRatio')).toBeNull()
    expect(svg.querySelector('text')).toBeNull()
    expect(screen.getByText('100%')).toBeInTheDocument()
  })
})
