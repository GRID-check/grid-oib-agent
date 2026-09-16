/**
 * Timeline — a vertical list of items joined by a hairline connector.
 *
 * The shape the Herleitung's fan already draws between stacked source cards: a
 * marker in the gutter, content beside it, and a one-pixel line in the edge
 * ink running from one marker to the next, so a column of rows reads as a
 * sequence rather than as a pile. It is a molecule of the kit rather than a
 * `<div>` in the run block because a second surface (the job run history, a
 * document's version trail) wants exactly this arrangement, and two hand-rolled
 * gutters drift on the first retune.
 *
 * The connector is absolutely positioned inside the item, from the marker's
 * bottom to the item's bottom, and the last item draws none: the line joins
 * rows, it does not trail off into nothing. Its colour is {@link TIMELINE_STROKE},
 * the same mix the reasoning graph strokes its edges with, so the two surfaces
 * agree on what "connected" looks like.
 */

import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The edge ink: foreground at 18%, mixed rather than a token so it sits on any
 * surface (muted, card, popover) in both themes without a second variable.
 */
export const TIMELINE_STROKE = 'color-mix(in oklch, var(--foreground) 18%, transparent)'

export interface TimelineProps extends Omit<ComponentProps<'ol'>, 'children'> {
  children: ReactNode
}

export function Timeline({ className, children, ...rest }: TimelineProps): JSX.Element {
  return (
    <ol data-slot="timeline" className={cn('flex flex-col', className)} {...rest}>
      {children}
    </ol>
  )
}

export interface TimelineItemProps extends Omit<ComponentProps<'li'>, 'children'> {
  /** What sits in the gutter: a swatch, an icon, a dot. Sized by the caller. */
  marker: ReactNode
  /**
   * The gutter's width and the marker's vertical seat. The connector is drawn
   * down the gutter's centre, so a marker wider than this is off the line.
   */
  gutter?: 'sm' | 'md'
  children: ReactNode
}

const GUTTER: Record<NonNullable<TimelineItemProps['gutter']>, { col: string; line: string }> = {
  // 14px marker (the phase swatch): the line sits at 7px.
  sm: { col: 'w-3.5', line: 'left-[6.5px]' },
  // 20px marker (a status icon): the line sits at 10px.
  md: { col: 'w-5', line: 'left-[9.5px]' },
}

export function TimelineItem({
  marker,
  gutter = 'sm',
  className,
  children,
  ...rest
}: TimelineItemProps): JSX.Element {
  const size = GUTTER[gutter]
  return (
    <li
      data-slot="timeline-item"
      className={cn('group/timeline-item relative flex gap-2.5 pb-3 last:pb-0', className)}
      {...rest}
    >
      {/* The marker's row height is the first line of text, so the swatch sits
          on the label rather than centred against a tall body. */}
      <span className={cn('relative z-10 flex shrink-0 justify-center pt-px', size.col)}>
        {marker}
      </span>
      <span
        aria-hidden
        className={cn(
          'absolute bottom-0 top-5 w-px group-last/timeline-item:hidden',
          size.line,
        )}
        style={{ backgroundColor: TIMELINE_STROKE }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </li>
  )
}
