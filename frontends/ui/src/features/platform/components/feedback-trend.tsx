'use client'

/**
 * Is it getting better? The daily HELPFUL rate, with the volume it rests on.
 *
 * The headline figure is a scoreboard; this is the part you can steer by.
 *
 * **Up is better.** Same data as a negative-rate chart, but the reader no longer
 * has to invert the shape before it means anything.
 *
 * **Rate, not count.** Votes per day would mostly plot traffic. The series is
 * the share of that day's votes that were helpful.
 *
 * **Two plots, never two y-axes.** Rate and volume are stacked, sharing one
 * x-axis: the rate line, and a volume strip underneath that says how much each
 * point is worth.
 *
 * **Thin days are drawn as unresolved, not as fact.** Below the floor a day's
 * point is dropped and the segments around it are dashed.
 *
 * **Drawn at the size it is shown.** The plot used to be a fixed 720-unit
 * viewBox stretched with `preserveAspectRatio="none"`, which squashed every
 * circle into an ellipse and every axis label into a different font width on
 * any card that was not 720px wide. The SVG now takes its measured width as its
 * coordinate system, and the text lives in HTML beside it.
 *
 * Window filling and direction arithmetic live in `@/lib/feedback/trend`,
 * shared with the digest, so the badge and the digest's sentence about
 * improvement are the same claim.
 */

import type { JSX } from 'react'
import { useEffect, useId, useMemo, useState } from 'react'
import { Minus, TrendingDown, TrendingUp } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { useLocale, useTranslations } from '@/i18n'
import {
  feedbackTrendAverage,
  feedbackTrendDelta,
  fillTrendWindow,
  MIN_TREND_VOTES,
  type FeedbackDayPoint,
} from '@/lib/feedback/trend'
import { cn } from '@/lib/utils'

export type FeedbackTrendPoint = FeedbackDayPoint

export interface FeedbackTrendProps {
  points: readonly FeedbackTrendPoint[]
  /** Days of the window, so gaps can be filled rather than skipped. */
  windowDays: number
  /**
   * The window's last day, `YYYY-MM-DD` (UTC). Defaults to today; a custom range
   * that ends in the past fills back from its own end, not from today.
   */
  endDay?: string
  /** Below this many votes a day's rate is not treated as a reading. */
  minVotes?: number
  className?: string
}

/** Noon of the window's last day, so the fill lands on that UTC calendar day; now without one. */
const endOf = (endDay: string | undefined): Date => (endDay ? new Date(`${endDay}T12:00:00Z`) : new Date())

const FALLBACK_W = 720
const RATE_H = 132
const VOL_H = 28
/** Inset so the end markers are not clipped by the plot edge. */
const PAD_X = 6
const PAD_Y = 8

/**
 * A `day` key is a UTC calendar date, and it has to be formatted as one.
 * `new Date('2026-07-30')` parses to midnight UTC, so a reader west of
 * Greenwich would otherwise see every label a day early.
 */
function formatDay(day: string, locale: string): string {
  return new Date(day).toLocaleDateString(locale, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  })
}

/**
 * The width of an element, live. A callback ref, so it attaches whenever the
 * plot mounts (the chart can first render as the "too sparse" sentence). Falls
 * back to a fixed width where there is no layout (tests, SSR).
 */
function useMeasuredWidth(): [(node: HTMLElement | null) => void, number] {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(FALLBACK_W)
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width)
      if (next > 0) setWidth(next)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  return [setNode, width]
}

/**
 * The direction, in words, as a badge: icon + label + tint. Measured first third
 * against last third (see `feedbackTrendDelta`), never endpoint against
 * endpoint. Renders nothing when too few days are readable to have a direction.
 */
export function FeedbackTrendDirection({
  points,
  windowDays,
  endDay,
  minVotes = MIN_TREND_VOTES,
}: Omit<FeedbackTrendProps, 'className'>): JSX.Element | null {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const delta = useMemo(
    () => feedbackTrendDelta(fillTrendWindow(points, windowDays, minVotes, endOf(endDay))),
    [points, windowDays, minVotes, endDay]
  )
  if (delta === null) return null
  const better = delta >= 1
  const worse = delta <= -1
  const Icon = better ? TrendingUp : worse ? TrendingDown : Minus
  return (
    <Badge
      variant={better ? 'success' : worse ? 'warning' : 'secondary'}
      className="tabular-nums"
      data-testid="feedback-trend-delta"
    >
      <Icon aria-hidden />
      {t(
        better
          ? 'answerFeedback.trendBetter'
          : worse
            ? 'answerFeedback.trendWorse'
            : 'answerFeedback.trendFlat',
        { points: Math.abs(delta).toLocaleString(locale, { maximumFractionDigits: 1 }) }
      )}
    </Badge>
  )
}

/**
 * The daily helpful rate over a stacked volume strip. Returns a sentence
 * instead of a chart when too few days are readable: a flat line at zero would
 * read as "every answer failed" instead of "we do not know".
 */
export function FeedbackTrend({
  points,
  windowDays,
  endDay,
  minVotes = MIN_TREND_VOTES,
  className,
}: FeedbackTrendProps): JSX.Element | null {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const clipId = useId()
  const [hover, setHover] = useState<number | null>(null)
  const [plotRef, width] = useMeasuredWidth()

  const days = useMemo(
    () => fillTrendWindow(points, windowDays, minVotes, endOf(endDay)),
    [points, windowDays, minVotes, endDay]
  )

  const readable = days.filter((d) => d.rate !== null)
  if (readable.length < 2) {
    return (
      <p
        className={cn('text-muted-foreground py-6 text-center text-sm', className)}
        data-testid="feedback-trend-empty"
      >
        {t('answerFeedback.trendTooSparse', { min: minVotes })}
      </p>
    )
  }

  // A share of a whole: the axis is the whole. Fitting it to the data would
  // redraw 88–92% as a mountain range.
  const maxVol = Math.max(1, ...days.map((d) => d.total))
  const step = days.length > 1 ? (width - PAD_X * 2) / (days.length - 1) : 0
  const x = (i: number): number => PAD_X + i * step
  const y = (rate: number): number => RATE_H - PAD_Y - (rate / 100) * (RATE_H - PAD_Y * 2)
  /** The same y as a share of the plot height, for the HTML labels laid over it. */
  const yPct = (rate: number): string => `${(y(rate) / RATE_H) * 100}%`

  // Segments rather than one path: a segment touching an unreadable day is
  // dashed. A segment between TWO unreadable days is dropped, never bridged
  // along the zero line.
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
  const hovered = hover !== null ? days[hover] : null
  const barW = Math.max(2, Math.min(14, step - 2))

  return (
    <figure className={cn('flex flex-col gap-2', className)} data-testid="feedback-trend">
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2">
        {/* The scale, in HTML so it keeps its type size at any plot width. */}
        <div
          className="text-muted-foreground relative text-[11px] tabular-nums"
          aria-hidden
          style={{ height: RATE_H }}
        >
          {[100, 50, 0].map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2"
              style={{ top: yPct(tick) }}
            >
              {t('answerFeedback.percent', { value: String(tick) })}
            </span>
          ))}
        </div>

        <div ref={plotRef} className="relative min-w-0">
          <svg
            width="100%"
            height={RATE_H}
            viewBox={`0 0 ${width} ${RATE_H}`}
            className="block"
            role="img"
            aria-label={t('answerFeedback.trendAria')}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x="0" y="0" width={width} height={RATE_H} />
              </clipPath>
            </defs>
            {[100, 50, 0].map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={width}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-border"
                strokeWidth={1}
              />
            ))}
            <line
              x1={0}
              x2={width}
              y1={y(average)}
              y2={y(average)}
              className="stroke-muted-foreground/60"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
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
              {hover !== null ? (
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={0}
                  y2={RATE_H}
                  className="stroke-muted-foreground/40"
                  strokeWidth={1}
                />
              ) : null}
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
                )
              )}
            </g>
            {/* Hit targets wider than the marks; a tap pins the reading on touch. */}
            {days.map((day, index) => (
              <rect
                key={`hit-${day.day}`}
                x={x(index) - step / 2}
                y={0}
                width={Math.max(step, 6)}
                height={RATE_H}
                fill="transparent"
                onMouseEnter={() => setHover(index)}
                onClick={() => setHover(index)}
              />
            ))}
          </svg>
        </div>

        {/* The volume strip: its own plot, its own scale, the same x. */}
        <span aria-hidden />
        <svg
          width="100%"
          height={VOL_H}
          viewBox={`0 0 ${width} ${VOL_H}`}
          className="mt-1 block"
          aria-hidden
        >
          {days.map((day, index) => {
            const h = (day.total / maxVol) * VOL_H
            return (
              <rect
                key={day.day}
                x={x(index) - barW / 2}
                y={VOL_H - h}
                width={barW}
                height={h}
                rx={1}
                className={cn(
                  'fill-muted-foreground',
                  hover === index ? 'opacity-60' : 'opacity-25'
                )}
              />
            )
          })}
        </svg>

        <span aria-hidden />
        <div className="text-muted-foreground mt-1 flex items-center justify-between gap-3 text-xs tabular-nums">
          <span>{days[0] ? formatDay(days[0].day, locale) : ''}</span>
          {hovered ? (
            <span
              className="text-foreground truncate font-medium"
              data-testid="feedback-trend-hover"
            >
              {formatDay(hovered.day, locale)} ·{' '}
              {hovered.rate === null
                ? t('answerFeedback.trendPointUnreadable', { votes: hovered.total })
                : t('answerFeedback.trendPoint', {
                    pct: hovered.rate.toLocaleString(locale, { maximumFractionDigits: 0 }),
                    votes: hovered.total,
                  })}
            </span>
          ) : null}
          <span>{days.at(-1) ? formatDay(days.at(-1)!.day, locale) : ''}</span>
        </div>
      </div>

      {/* Every swatch is the ACTUAL mark at the same weight and dash pattern:
          a measured day and an unmeasured one differ by dashing, which a
          coloured square cannot show. */}
      <figcaption
        className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs"
        data-testid="feedback-trend-legend"
      >
        <span className="inline-flex items-center gap-1.5">
          <svg width="20" height="8" aria-hidden className="shrink-0 overflow-visible">
            <line
              x1="0"
              y1="4"
              x2="20"
              y2="4"
              strokeWidth={2}
              style={{ stroke: 'var(--grid-series-1)' }}
            />
            <circle
              cx="10"
              cy="4"
              r="3"
              style={{ fill: 'var(--grid-series-1)' }}
              className="stroke-card"
              strokeWidth={2}
            />
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
            <line
              x1="0"
              y1="4"
              x2="20"
              y2="4"
              strokeWidth={1}
              strokeDasharray="4 4"
              className="stroke-muted-foreground/60"
            />
          </svg>
          {t('answerFeedback.legendAverage', {
            pct: average.toLocaleString(locale, { maximumFractionDigits: 1 }),
          })}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="20" height="8" aria-hidden className="shrink-0">
            <rect
              x="1"
              y="3"
              width="4"
              height="5"
              rx="1"
              className="fill-muted-foreground opacity-25"
            />
            <rect
              x="7"
              y="1"
              width="4"
              height="7"
              rx="1"
              className="fill-muted-foreground opacity-25"
            />
            <rect
              x="13"
              y="4"
              width="4"
              height="4"
              rx="1"
              className="fill-muted-foreground opacity-25"
            />
          </svg>
          {t('answerFeedback.legendVolume')}
        </span>
      </figcaption>
    </figure>
  )
}
