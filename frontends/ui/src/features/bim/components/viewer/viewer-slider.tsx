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
        'pointer-events-auto flex items-center gap-3 px-3 py-2',
        'animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none',
        className
      )}
    >
      <label htmlFor={id} className="text-xs whitespace-nowrap text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type="range"
        className="accent-foreground h-1 w-40 cursor-pointer sm:w-56"
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
