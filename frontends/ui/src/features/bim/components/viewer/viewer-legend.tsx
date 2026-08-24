'use client'

/**
 * What the colours on the building mean.
 *
 * Highlights arrive from somewhere else entirely — a health finding, a
 * compliance verdict, a chat answer that names six walls — so the reader who
 * sees three red elements did not choose the colour and has no way to know
 * what it is claiming. The legend is the sentence that makes a coloured model
 * readable instead of decorative.
 *
 * It renders only when there is something to explain, which is almost never:
 * the ordinary state of the viewport is an uncoloured building and no legend
 * at all.
 */

import { cn } from '@/lib/utils'
import { HIGHLIGHT_CSS, type BimHighlightStatus } from '../../lib/model-index'
import { ViewerSurface } from './viewer-surface'

export interface ViewerLegendEntry {
  status: BimHighlightStatus
  label: string
  /** How many elements this group actually resolved to in the loaded model. */
  count: number
}

export interface ViewerLegendProps {
  entries: readonly ViewerLegendEntry[]
  className?: string
}

export function ViewerLegend({ entries, className }: ViewerLegendProps): JSX.Element | null {
  if (entries.length === 0) return null

  return (
    <ul
      className={cn(
        'pointer-events-none flex max-w-[70%] flex-wrap gap-1.5',
        'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none',
        className
      )}
    >
      {entries.map((entry, position) => (
        <li
          // Position, not label. The URL form groups by STATUS, so
          // `?hl=fail:A&hl=fail:B` produces two groups sharing the translated
          // label "nicht erfüllt" — React then treats them as one row and
          // drops the second group's count from the legend while its elements
          // stay coloured on the model.
          key={`${entry.status}-${position}`}
        >
          <ViewerSurface className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full"
              style={{ backgroundColor: HIGHLIGHT_CSS[entry.status] }}
            />
            <span>{entry.label}</span>
            <span className="text-muted-foreground tabular-nums">({entry.count})</span>
          </ViewerSurface>
        </li>
      ))}
    </ul>
  )
}
