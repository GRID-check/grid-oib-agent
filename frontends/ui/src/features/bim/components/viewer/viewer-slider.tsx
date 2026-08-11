'use client'

/**
 * The one continuous control in the viewport: where the building is cut.
 *
 * It appears above the dock only while a cut is live, because a slider for a
 * thing that is switched off is a control that does nothing — and the old
 * toolbar kept it wedged into a corner beside six buttons where it was
 * unreadable at any width.
 *
 * A native `<input type="range">`, not a Radix slider. It is the pattern the
 * repo already uses, it is keyboard-operable and screen-reader-labelled for
 * free, and it drags correctly on a touchscreen without a line of code. The
 * `<output>` beside it is what turns "somewhere around there" into a number a
 * reader can put in an email.
 */

import { useId } from 'react'
import { cn } from '@/lib/utils'
import { ViewerSurface } from './viewer-surface'

export interface ViewerSliderProps {
  label: string
  min: number
  max: number
  step?: number
  value: number
  /** The value as the reader should read it, units and all: `2,60 m`. */
  display: string
  onChange: (value: number) => void
  /** A control that belongs to the slider — flipping the cut's direction. */
  action?: React.ReactNode
  disabled?: boolean
  className?: string
}

export function ViewerSlider({
  label,
  min,
  max,
  step = 0.05,
  value,
  display,
  onChange,
  action,
  disabled = false,
  className,
}: ViewerSliderProps): JSX.Element {
  const id = useId()

  return (
    <ViewerSurface
      className={cn(
        // `max-w-full`: the pill sits inside the dock's centred column, and
        // without a cap it grew past both edges of a phone — the label ran off
        // the left and the direction button off the right.
        'pointer-events-auto flex max-w-full items-center gap-2 px-3 py-2 sm:gap-3',
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none',
        className
      )}
    >
      {/*
        The label is the slider's accessible name, so it cannot simply be
        dropped on a narrow screen — it is hidden VISUALLY and still read. At
        390 px the pill has to hold a range, a number and a direction button,
        and a visible caption is the one part a reader can infer from the
        building changing under it.
      */}
      <label htmlFor={id} className="text-muted-foreground sr-only text-xs whitespace-nowrap sm:not-sr-only">
        {label}
      </label>
      <input
        id={id}
        type="range"
        className="accent-foreground h-1 w-24 min-w-0 flex-1 cursor-pointer sm:w-56 sm:flex-none"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output htmlFor={id} className="w-16 text-right font-mono text-xs tabular-nums">
        {display}
      </output>
      {action}
    </ViewerSurface>
  )
}
