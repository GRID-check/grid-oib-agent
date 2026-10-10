import type { JSX } from 'react'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The five feedback tones as INK, for marks that are filled rather than tinted.
 * A chip carries a tone as a tint pair (`chip.tsx`); a swatch and a meter
 * segment are solid, so they read the tone's text colour and fill with it
 * (`bg-current`). One table, so a retune of a feedback token moves both.
 */
export type MeterTone = 'success' | 'info' | 'warning' | 'destructive' | 'muted'

const TONE_INK: Record<MeterTone, string> = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  destructive: 'text-error',
  muted: 'text-muted-foreground/45',
}

/**
 * The status mark of the design language: a 10px square in the tone's ink,
 * always beside a word. Colour alone never carries the meaning, so this has no
 * label of its own and is hidden from assistive technology — the word beside
 * it is what is read.
 */
export function ToneSwatch({ tone, className }: { tone: MeterTone; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      data-slot="tone-swatch"
      className={cn('inline-block size-2.5 shrink-0 rounded-[3px] bg-current', TONE_INK[tone], className)}
    />
  )
}

export interface MeterSegment {
  key: string
  value: number
  tone: MeterTone
}

export interface SegmentMeterProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role'> {
  segments: readonly MeterSegment[]
  /**
   * What the bar says, in words — required, because a row of coloured lengths
   * is not something a screen reader can describe. Typically the same sentence
   * the surface prints beside it.
   */
  label: string
}

/**
 * A single bar split into proportional segments: how a whole divides into
 * states (read / being read / failed). Zero-valued segments are not drawn; an
 * all-zero meter is an empty track, never a full one.
 *
 * Widths are flex-grow weights rather than percentages, so rounding can never
 * leave a gap at the end or push the last segment past the track.
 */
export function SegmentMeter({ segments, label, className, ...props }: SegmentMeterProps): JSX.Element {
  const drawn = segments.filter((segment) => segment.value > 0)
  return (
    <div
      role="img"
      aria-label={label}
      data-slot="segment-meter"
      className={cn('bg-muted flex h-2 w-full gap-px overflow-hidden rounded-full', className)}
      {...props}
    >
      {drawn.map((segment) => (
        <span
          key={segment.key}
          data-segment={segment.key}
          className={cn('h-full min-w-1 bg-current transition-[flex-grow] duration-base ease-out motion-reduce:transition-none', TONE_INK[segment.tone])}
          style={{ flexGrow: segment.value, flexBasis: 0 }}
        />
      ))}
    </div>
  )
}
