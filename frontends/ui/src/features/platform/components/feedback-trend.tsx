'use client'

/**
 * Is it getting better? — the daily HELPFUL rate, with the volume it rests on.
 *
 * The headline figure is a scoreboard; this is the part you can steer by. A
 * platform owner improving answers needs the DIRECTION, and a single number for a
 * window cannot carry one.
 *
 * **Up is better.** This plotted the negative share until the surface was, fairly,
 * accused of only ever showing the bad half. Same data either way — but on a
 * negative-rate chart every reader has to invert the shape before it means
 * anything, and the label "3 points better" sat above a line that had just
 * fallen. The good direction is now the up direction.
 *
 * **Rate, not count.** Plotting votes per day would mostly plot traffic: a busy
 * Tuesday produces more of everything without anything having changed. The series
 * is the share of that day's votes that were helpful.
 *
 * **Two plots, never two y-axes.** Rate and volume are different scales, and a
 * dual-axis chart lets the reader "see" a correlation that is an artefact of two
 * arbitrary scalings. They are stacked instead, sharing one x-axis: the rate
 * line, and a volume strip underneath that says how much each point is worth.
 *
 * **Thin days are drawn as unresolved, not as fact.** One down-vote out of two is
 * 50% and would spike the line into something that looks like a collapse. Those
 * points are dropped and the segments around them dashed — the reader can see the
 * shape without being invited to believe it.
 *
 * The window filling and the direction arithmetic live in `@/lib/feedback/trend`,
 * shared with the digest: the chart's "3.4 points better" and the digest's
 * sentence about improvement are the same claim, and two implementations of it
 * would eventually disagree on one screen.
 */

import { useId, useMemo, useState } from 'react'
import type { JSX } from 'react'

import { useLocale, useTranslations } from '@/i18n'
import {
  feedbackTrendAverage,
  feedbackTrendDelta,
  fillTrendWindow,
  MIN_TREND_VOTES,
  type FeedbackDayPoint,
} from '@/lib/feedback/trend'
import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'

export type FeedbackTrendPoint = FeedbackDayPoint

export interface FeedbackTrendProps {
  points: readonly FeedbackTrendPoint[]
  /** Days of the window, so gaps can be filled rather than skipped. */
  windowDays: number
  /** Below this many votes a day's rate is not treated as a reading. */
  minVotes?: number
  className?: string
}

const VIEW_W = 720
const RATE_H = 120
const VOL_H = 28
/** Left gutter for the y labels — without a scale the line has no magnitude. */
const PAD_X = 34

/**
 * A `day` key is a UTC calendar date, and it has to be formatted as one.
 * `new Date('2026-07-30')` parses to midnight UTC, so a reader west of Greenwich
 * would otherwise see every label a day early — the axis and the hover would
 * disagree with the data by one day, invisibly.
 */
function formatDay(day: string, locale: string): string {
  return new Date(day).toLocaleDateString(locale, { timeZone: 'UTC' })
}

/**
 * The daily helpful rate over a stacked volume strip, with the direction stated
 * in words. Returns a sentence instead of a chart when too few days are
 * readable — see the module note on why that is not a flat line.
 */
export function FeedbackTrend({
  points,
  windowDays,
  minVotes = MIN_TREND_VOTES,
  className,
}: FeedbackTrendProps): JSX.Element | null {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const clipId = useId()
  const [hover, setHover] = useState<number | null>(null)

  const days = useMemo(
    () => fillTrendWindow(points, windowDays, minVotes),
    [points, windowDays, minVotes],
  )

  const readable = days.filter((d) => d.rate !== null)
  // Nothing to draw a direction from. Said in words rather than as a flat line at
  // zero, which would read as "every answer failed" instead of "we do not know".
  if (readable.length < 2) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)} data-testid="feedback-trend-empty">
        {t('answerFeedback.trendTooSparse', { min: minVotes })}
      </p>
    )
  }

  // The helpful rate is a share of a whole, so the axis is the whole: fitting it
  // to the data would redraw 88%–92% as a mountain range. 100% is the top.
  const maxRate = 100
  const maxVol = Math.max(1, ...days.map((d) => d.total))
  const step = days.length > 1 ? (VIEW_W - PAD_X * 2) / (days.length - 1) : 0
  const x = (i: number): number => PAD_X + i * step
  const y = (rate: number): number => RATE_H - (rate / maxRate) * (RATE_H - 12) - 6

  // Segments rather than one path: a segment touching an unreadable day is dashed,
  // so the line stays continuous to look at while saying which parts are inferred.
  // A segment between TWO unreadable days is dropped entirely — bridging it with
  // `?? 0` drew a stray dash along the zero line, which reads as a real reading of
  // "no negative feedback" when the truth is "no data".
  const segments = days.slice(1).flatMap((day, index) => {
    const prev = days[index]
    if (prev.rate === null && day.rate === null) return []
    return [
      {
        key: day.day,
        x1: x(index),
        y1: y(prev.rate ?? day.rate ?? 0),
        x2: x(index + 1),
        y2: y(day.rate ?? prev.rate ?? 0),
        solid: prev.rate !== null && day.rate !== null,
      },
    ]
  })

  const average = feedbackTrendAverage(days)
  // Positive = the helpful rate rose = better. Measured first third against last
  // third, not endpoint against endpoint — see `feedbackTrendDelta`.
  const delta = feedbackTrendDelta(days) ?? 0
  const hovered = hover !== null ? days[hover] : null

  return (
    <div className={cn('space-y-1.5', className)} data-testid="feedback-trend">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel as="h3">{t('answerFeedback.trendHeading')}</SectionLabel>
        {/* The direction, in words. A reader should not have to measure the slope
            to learn whether the thing they are responsible for is improving. */}
        <p
          className={cn(
            'text-xs font-medium tabular-nums',
            delta >= 1 ? 'text-success' : delta <= -1 ? 'text-warning' : 'text-muted-foreground',
          )}
          data-testid="feedback-trend-delta"
        >
          {t(
            delta >= 1
              ? 'answerFeedback.trendBetter'
              : delta <= -1
                ? 'answerFeedback.trendWorse'
                : 'answerFeedback.trendFlat',
            { points: Math.abs(delta).toLocaleString(locale, { maximumFractionDigits: 1 }) },
          )}
        </p>
      </div>

      <figure className="space-y-1">
        <svg
          viewBox={`0 0 ${VIEW_W} ${RATE_H}`}
          className="h-28 w-full"
          role="img"
          aria-label={t('answerFeedback.trendAria')}
          preserveAspectRatio="none"
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x="0" y="0" width={VIEW_W} height={RATE_H} />
            </clipPath>
          </defs>

          {/* The scale. Two labels — the top of the axis and zero — because a line
              with no magnitude is a shape, not a measurement: 10% and 40% draw
              identically when the axis auto-fits. */}
          {/* SVG user units, not CSS pixels — this chart draws into a viewBox
              with `preserveAspectRatio="none"`, so these sizes are measurements
              inside the plot's coordinate system and the type ramp does not
              apply to them. */}
          <text x={4} y={y(maxRate) + 4} className="fill-muted-foreground text-[10px]">
            {t('answerFeedback.percent', { value: Math.round(maxRate).toString() })}
          </text>
          <text x={4} y={y(0)} className="fill-muted-foreground text-[10px]">
            {t('answerFeedback.percent', { value: '0' })}
          </text>

          {/* One recessive reference line at the window's own average, LABELLED —
              an unexplained dashed line is furniture the reader has to guess at. */}
          <line
            x1={PAD_X}
            x2={VIEW_W - 30}
            y1={y(average)}
            y2={y(average)}
            className="stroke-border"
            strokeDasharray="3 3"
            strokeWidth={1}
          />
          <text
            x={VIEW_W - 26}
            y={y(average) + 3}
            // 9.5 SVG user units, a half-step under the axis labels above so
            // the reference mark stays subordinate to the scale it annotates.
            // Same coordinate system as those labels (see the note there) —
            // not CSS pixels, so the type ramp does not apply.
            className="fill-muted-foreground/80 text-[9.5px]"
          >
            {t('answerFeedback.trendAverageMark')}
          </text>
          <g clipPath={`url(#${clipId})`}>
            {segments.map((seg) => (
              <line
                key={seg.key}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray={seg.solid ? undefined : '3 4'}
                style={{ stroke: 'var(--grid-series-1)' }}
                opacity={seg.solid ? 1 : 0.45}
              />
            ))}
            {days.map((day, index) =>
              day.rate === null ? null : (
                <circle
                  key={day.day}
                  cx={x(index)}
                  cy={y(day.rate)}
                  r={hover === index ? 4.5 : 3}
                  style={{ fill: 'var(--grid-series-1)' }}
                  className="stroke-card"
                  strokeWidth={2}
                />
              ),
            )}
          </g>
          {/* Hit targets wider than the marks — the skill's interaction rule. */}
          {days.map((day, index) => (
            <rect
              key={`hit-${day.day}`}
              x={x(index) - step / 2}
              y={0}
              width={Math.max(step, 6)}
              height={RATE_H}
              fill="transparent"
              onMouseEnter={() => setHover(index)}
            />
          ))}
        </svg>

        {/* The volume strip. Its own plot, its own scale, one shared x — never a
            second y-axis on the chart above. */}
        <svg
          viewBox={`0 0 ${VIEW_W} ${VOL_H}`}
          className="h-7 w-full"
          aria-hidden
          preserveAspectRatio="none"
        >
          {days.map((day, index) => (
            <rect
              key={day.day}
              x={x(index) - Math.max(1, step / 2 - 1)}
              y={VOL_H - (day.total / maxVol) * VOL_H}
              width={Math.max(2, step - 2)}
              height={(day.total / maxVol) * VOL_H}
              rx={1}
              className={cn('fill-muted-foreground', hover === index ? 'opacity-60' : 'opacity-25')}
            />
          ))}
        </svg>

        {/* Dates on the axis they belong to, alone — the legend below explains the
            marks, and mixing the two put four unrelated facts on one line. */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{days[0] ? formatDay(days[0].day, locale) : ''}</span>
          {hovered && (
            <span className="font-medium text-foreground" data-testid="feedback-trend-hover">
              {formatDay(hovered.day, locale)} ·{' '}
              {hovered.rate === null
                ? t('answerFeedback.trendPointUnreadable', { votes: hovered.total })
                : t('answerFeedback.trendPoint', {
                    pct: hovered.rate.toLocaleString(locale, { maximumFractionDigits: 0 }),
                    votes: hovered.total,
                  })}
            </span>
          )}
          <span>{days.at(-1) ? formatDay(days.at(-1)!.day, locale) : ''}</span>
        </div>

        {/*
          The legend. Every swatch is the ACTUAL mark drawn at the same weight and
          dash pattern, not a coloured square standing in for it: the two states
          that matter here — a measured day and an unmeasured one — differ by
          dashing, and a square cannot show that. Four marks appear on this figure
          and all four are named; a dashed line the reader has to guess at is worse
          than no reference line.
        */}
        <figcaption
          className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-0.5 text-xs text-muted-foreground"
          data-testid="feedback-trend-legend"
        >
          <span className="inline-flex items-center gap-1.5">
            <svg width="20" height="8" aria-hidden className="shrink-0 overflow-visible">
              <line x1="0" y1="4" x2="20" y2="4" strokeWidth={2} style={{ stroke: 'var(--grid-series-1)' }} />
              <circle cx="10" cy="4" r="3" style={{ fill: 'var(--grid-series-1)' }} className="stroke-card" strokeWidth={2} />
            </svg>
            {t('answerFeedback.legendRate')}
          </span>

          <span className="inline-flex items-center gap-1.5">
            <svg width="20" height="8" aria-hidden className="shrink-0">
              <line
                x1="0"
                y1="4"
                x2="20"
                y2="4"
                strokeWidth={2}
                strokeDasharray="3 4"
                opacity={0.45}
                style={{ stroke: 'var(--grid-series-1)' }}
              />
            </svg>
            {t('answerFeedback.legendSparse', { min: minVotes })}
          </span>

          <span className="inline-flex items-center gap-1.5">
            <svg width="20" height="8" aria-hidden className="shrink-0">
              <line x1="0" y1="4" x2="20" y2="4" strokeWidth={1} strokeDasharray="3 3" className="stroke-border" />
            </svg>
            {t('answerFeedback.legendAverage', {
              pct: average.toLocaleString(locale, { maximumFractionDigits: 1 }),
            })}
          </span>

          <span className="inline-flex items-center gap-1.5">
            <svg width="20" height="8" aria-hidden className="shrink-0">
              <rect x="1" y="3" width="4" height="5" rx="1" className="fill-muted-foreground opacity-25" />
              <rect x="7" y="1" width="4" height="7" rx="1" className="fill-muted-foreground opacity-25" />
              <rect x="13" y="4" width="4" height="4" rx="1" className="fill-muted-foreground opacity-25" />
            </svg>
            {t('answerFeedback.legendVolume')}
          </span>
        </figcaption>
      </figure>
    </div>
  )
}
