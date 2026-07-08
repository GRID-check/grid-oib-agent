'use client'

/**
 * Daily spend trend — single-series bar chart (30 UTC days, zero-filled by
 * the service). Dataviz specs: thin bars with 2px surface gaps and rounded
 * data ends, recessive baseline, no legend for a single series (the card
 * title names it), full-column hover targets with a per-day tooltip, and all
 * text in text tokens (color only ever paints the marks).
 */

import { type FC } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SeriesPaletteStyle } from '@/components/charts/palette'
import { formatEur as eur } from '@/lib/format'
import { useLocale } from '@/i18n'

export interface SpendTrendPoint {
  day: string
  usd: number
  events: number
}

interface SpendTrendChartProps {
  points: SpendTrendPoint[]
  eurPerUsd: number
  requestsLabel: (count: number) => string
  emptyLabel: string
}

export const SpendTrendChart: FC<SpendTrendChartProps> = ({ points, eurPerUsd, requestsLabel, emptyLabel }) => {
  const { locale } = useLocale()
  const maxUsd = Math.max(...points.map((point) => point.usd), 0)
  const dateLabel = (day: string): string =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })

  if (points.length === 0 || maxUsd <= 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }

  return (
    <TooltipProvider delayDuration={100}>
      <SeriesPaletteStyle />
      {/* Wide content scrolls in its own container — 30 columns need a
          width floor to stay hoverable, so narrow viewports pan the chart
          instead of collapsing bars below usable hit-target size. */}
      <div className="grid-usage-viz overflow-x-auto">
        <div className="min-w-[420px]">
          <div className="flex justify-end">
            <span className="text-[10px] font-medium uppercase leading-4 text-muted-foreground">
              {eur(maxUsd * eurPerUsd)}
            </span>
          </div>
          <div className="flex h-24 items-end gap-[2px] border-b border-border/60" role="img">
            {points.map((point) => (
              <Tooltip key={point.day}>
                {/* Full-height column = hit target bigger than the mark. */}
                <TooltipTrigger asChild>
                  <div className="flex h-full min-w-[6px] flex-1 cursor-default items-end">
                    {point.usd > 0 ? (
                      <div
                        className="w-full rounded-t-[3px]"
                        style={{
                          backgroundColor: 'var(--grid-series-1)',
                          height: `${Math.max((point.usd / maxUsd) * 100, 3)}%`,
                        }}
                      />
                    ) : (
                      <div className="h-px w-full bg-border" />
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">{dateLabel(point.day)}</p>
                  <p className="tabular-nums">
                    {eur(point.usd * eurPerUsd)} · {requestsLabel(point.events)}
                  </p>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] font-medium uppercase leading-4 text-muted-foreground">
            <span>{dateLabel(points[0].day)}</span>
            <span>{dateLabel(points[points.length - 1].day)}</span>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
