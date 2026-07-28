'use client'

/**
 * Citation defects per day — stacked bar chart over the selected UTC window.
 *
 * Dataviz specs: thin bars with 2px surface gaps between columns AND between
 * stacked segments, rounded data end on the topmost segment only, recessive
 * baseline, a legend (>=2 series is never color-alone), full-column hover
 * targets with a per-day breakdown tooltip, and all text in text tokens —
 * color only ever paints the marks. Series colors come from the validated
 * categorical palette in fixed slot order, so a kind keeps its hue even when
 * another kind disappears from the window.
 */

import { type FC } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SeriesPaletteStyle } from '@/components/charts/palette'
import { useLocale } from '@/i18n'

export interface CitationDefectPoint {
  day: string
  turns: number
  defectTurns: number
  byKind: Record<string, number>
}

interface CitationDefectChartProps {
  points: CitationDefectPoint[]
  /** Defect kinds to stack, in fixed palette-slot order. */
  kinds: readonly string[]
  kindLabel: (kind: string) => string
  turnsLabel: (count: number) => string
  emptyLabel: string
  /** Accessible name for the plot; the table-equivalent lives in the tooltips. */
  ariaLabel: string
}

/**
 * Palette slot for a kind — its INDEX in the caller's fixed `kinds` list, not
 * its rank in the current window. Filtering the window must never repaint the
 * surviving series.
 */
const seriesVar = (index: number): string => `var(--grid-series-${(index % 8) + 1})`

export const CitationDefectChart: FC<CitationDefectChartProps> = ({
  points,
  kinds,
  kindLabel,
  turnsLabel,
  emptyLabel,
  ariaLabel,
}) => {
  const { locale } = useLocale()
  const stackTotal = (point: CitationDefectPoint): number =>
    kinds.reduce((sum, kind) => sum + (point.byKind[kind] ?? 0), 0)
  const maxStack = Math.max(...points.map(stackTotal), 0)

  const dateLabel = (day: string): string =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })

  if (points.length === 0 || maxStack <= 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }

  // Only the kinds actually present get a legend entry, but each keeps the
  // color of its slot in the full `kinds` list.
  const presentKinds = kinds
    .map((kind, index) => ({ kind, index }))
    .filter(({ kind }) => points.some((point) => (point.byKind[kind] ?? 0) > 0))

  return (
    <TooltipProvider delayDuration={100}>
      <SeriesPaletteStyle />
      {/* Wide content scrolls in its own container — a 30-column chart needs a
          width floor to stay hoverable on narrow viewports. */}
      <div className="grid-usage-viz overflow-x-auto">
        <div className="min-w-[420px]">
          <div className="flex justify-end">
            <span className="text-[10px] font-medium uppercase leading-4 text-muted-foreground">
              {turnsLabel(maxStack)}
            </span>
          </div>
          {/* Deliberately NOT role="img": that would collapse the whole plot
              into one opaque node and hide the per-day tooltip triggers from
              assistive tech. The group keeps an accessible name; each column
              below is its own focusable, describable target. */}
          <div className="flex h-24 items-end gap-[2px] border-b border-border/60" role="group" aria-label={ariaLabel}>
            {points.map((point) => {
              const total = stackTotal(point)
              return (
                <Tooltip key={point.day}>
                  {/* Full-height column = hit target bigger than the mark.
                      tabIndex makes it reachable by keyboard, so the tooltip's
                      per-day breakdown is not mouse-only. */}
                  <TooltipTrigger asChild>
                    <div
                      tabIndex={0}
                      role="button"
                      aria-label={`${dateLabel(point.day)}: ${turnsLabel(total)}`}
                      className="flex h-full min-w-[6px] flex-1 cursor-default flex-col justify-end gap-[2px] rounded-[3px] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                    >
                      {total > 0 ? (
                        presentKinds
                          // Bottom-up stack: render in reverse so slot 1 sits
                          // on the baseline and the rounded end lands on top.
                          .filter(({ kind }) => (point.byKind[kind] ?? 0) > 0)
                          .reverse()
                          .map(({ kind, index }, position) => (
                            <div
                              key={kind}
                              className={position === 0 ? 'w-full rounded-t-[3px]' : 'w-full'}
                              style={{
                                backgroundColor: seriesVar(index),
                                height: `${Math.max(((point.byKind[kind] ?? 0) / maxStack) * 100, 3)}%`,
                              }}
                            />
                          ))
                      ) : (
                        <div className="h-px w-full bg-border" />
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">{dateLabel(point.day)}</p>
                    <p className="tabular-nums text-muted-foreground">{turnsLabel(point.turns)}</p>
                    {total === 0 ? null : (
                      <ul className="mt-1 space-y-0.5">
                        {presentKinds
                          .filter(({ kind }) => (point.byKind[kind] ?? 0) > 0)
                          .map(({ kind, index }) => (
                            <li key={kind} className="flex items-center gap-1.5">
                              <span
                                className="size-2 shrink-0 rounded-[2px]"
                                style={{ backgroundColor: seriesVar(index) }}
                                aria-hidden
                              />
                              <span>{kindLabel(kind)}</span>
                              <span className="ml-auto tabular-nums">{point.byKind[kind]}</span>
                            </li>
                          ))}
                      </ul>
                    )}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
          <div className="mt-1 flex justify-between text-[10px] font-medium uppercase leading-4 text-muted-foreground">
            <span>{dateLabel(points[0].day)}</span>
            <span>{dateLabel(points[points.length - 1].day)}</span>
          </div>
        </div>
      </div>
      {/* Legend: identity is never color-alone. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {presentKinds.map(({ kind, index }) => (
          <li key={kind} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: seriesVar(index) }}
              aria-hidden
            />
            {kindLabel(kind)}
          </li>
        ))}
      </ul>
    </TooltipProvider>
  )
}
