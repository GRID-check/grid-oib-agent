'use client'

/**
 * The floating control bar at the bottom of the viewport.
 *
 * Bottom-centre, not top-right, and that is the whole argument of this
 * redesign in one component. Controls parked in a corner read as a toolbar
 * attached to a document; controls floating at the bottom edge read as the
 * tools of the thing you are looking at — the arrangement Figma, Miro and
 * every drawing app converged on, because it keeps the hand out of the middle
 * of the work and puts the controls where the eye already returns.
 *
 * Three parts, deliberately: a leading slot that is its OWN pill (for the one
 * control that is not a tool — Home), the tool group, and a trailing slot.
 * The gap between the pills is what separates "get me back" from "change what
 * I see", and it is why the bar does not read as one undifferentiated row of
 * nine icons.
 *
 * The dock never covers the model with a dead zone: the positioning wrapper is
 * `pointer-events-none` and only the pills themselves take the pointer, so a
 * drag that starts beside a button still orbits the building.
 */

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ViewerSurface } from './viewer-surface'

export interface ViewerDockProps {
  /** Its own pill, set apart from the tools. */
  lead?: ReactNode
  /** The tool group. */
  children: ReactNode
  /** Its own pill on the far side — the way out to the advanced surfaces. */
  trail?: ReactNode
  /** Rendered above the bar: the section-height slider, when a cut is live. */
  above?: ReactNode
  className?: string
}

export function ViewerDock({ lead, children, trail, above, className }: ViewerDockProps): JSX.Element {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 p-3 sm:p-4',
        className
      )}
    >
      {above}
      <div className="pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto">
        {lead && <ViewerSurface className="flex items-center gap-1 p-1">{lead}</ViewerSurface>}
        <ViewerSurface className="flex items-center gap-1 p-1">{children}</ViewerSurface>
        {trail && <ViewerSurface className="flex items-center gap-1 p-1">{trail}</ViewerSurface>}
      </div>
    </div>
  )
}

/**
 * A hairline between two groups of tools inside one pill.
 *
 * `aria-hidden` because it is punctuation: a screen reader announcing
 * "separator" between every pair of buttons is noise, and the grouping it
 * expresses is already carried by each control's own name.
 */
export function ViewerDockSeparator(): JSX.Element {
  return <span aria-hidden="true" className="mx-0.5 h-6 w-px shrink-0 bg-border" />
}
