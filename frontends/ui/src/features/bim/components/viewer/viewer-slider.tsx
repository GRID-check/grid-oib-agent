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
 * free, and it drags correctly on a touchscreen once it is tall enough to be
 * acquired by a finger (see the class list). The `<output>` beside it is what
 * turns "somewhere around there" into a number a reader can put in an email.
 *
 * ## Two callbacks, because a drag is not one event
 *
 * `onChange` fires per step and `onCommit` once the gesture settles. The split
 * is not a nicety — it is what makes the control usable at all.
 *
 * A controlled range input is pinned to the `value` prop: the browser moves
 * the thumb, React renders, and whatever `value` says wins. When the owner of
 * that value only updates it after a round trip — the cut height lived in the
 * URL, so every step of the drag was a `router.replace` and a server
 * re-render — the thumb is reset to a stale number faster than the reader can
 * drag away from it. The control does not move. It does not fail visibly
 * either: it just sits at the value it was opened with, which is exactly how
 * this was reported ("cannot go below 1.55 m" — 1.55 being the default the
 * Schnitt button had set).
 *
 * So: cheap, synchronous state on `onChange`; the expensive write on
 * `onCommit`, once per gesture.
 */

import { useId, useRef } from 'react'
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
  /**
   * Fires on every step of the drag. Whatever this does must be cheap enough
   * to run sixty times a second and must move {@link value} SYNCHRONOUSLY —
   * this is a controlled input, so a handler that takes a round trip to update
   * the value leaves the browser resetting the thumb under the reader's
   * finger, and the control reads as stuck.
   */
  onChange: (value: number) => void
  /**
   * Fires once the drag settles: pointer released, key released, focus lost.
   *
   * This is where an expensive write belongs — the URL, the server, anything
   * that is one event per gesture rather than one per pixel. Omitted means the
   * control has no expensive half.
   */
  onCommit?: (value: number) => void
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
  onCommit,
  action,
  disabled = false,
  className,
}: ViewerSliderProps): JSX.Element {
  const id = useId()

  /**
   * The value the last commit was for.
   *
   * A gesture can end in four ways — releasing the pointer, releasing a key,
   * tabbing away, and a click on the track that does all of it at once — and
   * several of them fire together. Without this, one drag writes the same
   * value two or three times, which on a URL means two or three history
   * entries and two or three server round trips for one movement.
   */
  const committed = useRef(value)
  const commit = (): void => {
    if (!onCommit || committed.current === value) return
    committed.current = value
    onCommit(value)
  }

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
        /*
          `pointer-coarse:h-11` rather than the `touch-target` utility: that
          one works through an `::after` overlay, and a pseudo-element on a
          replaced element like `<input>` is never rendered. The box itself has
          to grow.

          It has to grow because pointer hit-testing on a range is bounded by
          the ELEMENT box, not by the drawn thumb — so a `h-1` slider gives a
          finger a 4 px band to land on, and at `flex-1` on a phone that band
          is a 4 px × 150 px sliver between the readout and the flip button.
          The track and thumb stay centred in the taller box, so nothing about
          the control looks different.
        */
        className="accent-foreground h-1 w-24 min-w-0 flex-1 cursor-pointer pointer-coarse:h-11 sm:w-56 sm:flex-none"
        min={min}
        max={max}
        step={step}
        value={value}
        // Without this a screen reader announces "2.6" while the readout
        // beside it says "2,60 m". The formatted string is already in scope.
        aria-valuetext={display}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        // Every way a gesture can end. `pointerup` covers dragging and a click
        // on the track, `keyup` the arrow keys and Home/End, and `blur` the
        // case where the pointer was released outside the window — without
        // that last one a drag that ends off-screen never commits, and the
        // reader's cut is on screen but not in the link they then copy.
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      {/*
        `<output>` has an implicit `role="status"`, which would announce the
        value a second time on every step of a drag now that the range itself
        carries `aria-valuetext`.
      */}
      <output aria-live="off" htmlFor={id} className="w-16 text-right font-mono text-xs tabular-nums">
        {display}
      </output>
      {action}
    </ViewerSurface>
  )
}
