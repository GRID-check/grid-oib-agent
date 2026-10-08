'use client'

/**
 * A magnitude bar list whose rows are also filters: the "why it missed" and
 * "by topic" breakdowns of the answer-feedback surface.
 *
 * A four-category magnitude comparison is a bar list, which is plain HTML and
 * needs no chart library. ONE hue for every bar (`--grid-series-1`, scoped by
 * the organism's `grid-usage-viz`): the job is comparing length, every bar
 * already carries its own label and its own number, and a categorical hue per
 * row would encode nothing.
 *
 * The WHOLE row is the button. The first version made only the label a
 * dotted-underline link, so the widest part of the row (the bar) was dead and a
 * phone reader had to hit a word-sized target.
 */

import type { JSX, ReactNode } from 'react'

import { FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import { cn } from '@/lib/utils'

export function FeedbackBarList({
  children,
  testId,
  className,
}: {
  children: ReactNode
  testId?: string
  className?: string
}): JSX.Element {
  return (
    // A container, so each row lays out by the width of ITS card: the same
    // list sits in a half-width column on a laptop and full width on a phone.
    <ul className={cn('@container -mx-2 flex flex-col', className)} data-testid={testId}>
      {children}
    </ul>
  )
}

export interface FeedbackBarRowProps {
  label: string
  /** Bar length as a share of the track, 0–100. `null` draws an empty track (no reading). */
  pct: number | null
  /** The figure at the end of the row. */
  value: ReactNode
  /** A quieter figure before it (volume behind a rate). */
  meta?: ReactNode
  /** Spoken after the label, so the button's name carries the number too. */
  valueLabel: string
  selected: boolean
  onSelect: () => void
  testId?: string
  /** Hover text, for a value that needs explaining (a withheld rate). */
  title?: string
}

export function FeedbackBarRow({
  label,
  pct,
  value,
  meta,
  valueLabel,
  selected,
  onSelect,
  testId,
  title,
}: FeedbackBarRowProps): JSX.Element {
  return (
    <li data-testid={testId} data-selected={selected || undefined}>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${label}, ${valueLabel}`}
        title={title}
        className={cn(
          // Narrow: label and figure on one line, the bar full width under them,
          // so the bar never shrinks to a dot beside a long volume label.
          // From 28rem of card: one line, label | bar | figure.
          'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-md px-2 py-2 text-left text-sm',
          '@md:grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_auto]',
          'duration-quick pointer-coarse:min-h-11 transition-colors ease-out motion-reduce:transition-none',
          'outline-none',
          FOCUS_RING_INSET,
          selected ? 'bg-accent text-foreground' : 'text-foreground hover:bg-accent/50'
        )}
      >
        <span className={cn('truncate', selected && 'font-medium')}>{label}</span>
        <span
          className="bg-muted @md:col-span-1 @md:col-start-2 @md:row-start-1 col-span-2 row-start-2 h-2 overflow-hidden rounded-full"
          aria-hidden
        >
          {pct !== null ? (
            <span
              // Slid in from the left, as `Progress` does: a transform, so a
              // refetch that moves the bar composites instead of re-laying out.
              className="duration-base block h-full w-full rounded-full transition-transform ease-out motion-reduce:transition-none"
              style={{
                transform: `translateX(-${100 - Math.max(0, Math.min(100, pct))}%)`,
                backgroundColor: 'var(--grid-series-1)',
              }}
            />
          ) : null}
        </span>
        <span
          className="@md:col-start-3 col-start-2 row-start-1 flex items-baseline justify-end gap-2 tabular-nums"
          aria-hidden
        >
          {meta ? <span className="text-muted-foreground text-xs">{meta}</span> : null}
          <span className="min-w-9 text-right font-medium">{value}</span>
        </span>
      </button>
    </li>
  )
}
