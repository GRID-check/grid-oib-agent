/**
 * PhaseRail — a short sequence of phases, read left to right, with one live.
 *
 * Not the form `Stepper`: that one is a CONTROL (every visited step is a button
 * the reader can go back to, and it counts „Schritt 2 von 4" because an unknown
 * remaining cost is what people abandon). This is a READOUT of work somebody
 * else is doing — nothing here is pressable, and the phases are not a cost the
 * reader pays. What it has to say is which phases are behind the run, which one
 * it is in, and which are still to come, at a glance and without reading.
 *
 * It says it with the product's status swatch. A done phase is the filled ink
 * square with a check in it, the live phase is the same square as a ring — and
 * the ONE pulse this surface is allowed — and a pending phase is the square in
 * border grey. Colour never travels alone: the label beside each swatch carries
 * the state in weight (bold for live, ink for done, muted for pending), the
 * live step carries `aria-current="step"`, and a visually-hidden word states
 * the state for readers who see none of the above.
 *
 * `PhaseSwatch` is exported on its own so the vertical phase list under the rail
 * can mark its rows with the same square; a rail and a list that drew two
 * different "done" marks would be two lookalikes on one surface.
 */

import { Check } from 'lucide-react'

import { cn } from '@/lib/utils'

export type PhaseRailState = 'done' | 'active' | 'pending'

export interface PhaseRailStep {
  key: string
  label: string
  state: PhaseRailState
  /** The spoken state, for the visually-hidden word. */
  stateLabel: string
}

export interface PhaseSwatchProps {
  state: PhaseRailState
  /** Let the live swatch breathe — only one element on screen may. */
  pulse?: boolean
  className?: string
}

/**
 * The status square, sized so the check inside it is a check rather than a
 * smudge: 14px, not the title-line swatch's 10px, because this one has a glyph
 * to hold. Same radius family, same ink, so it still reads as that square.
 */
export function PhaseSwatch({ state, pulse = false, className }: PhaseSwatchProps): JSX.Element {
  return (
    <span
      aria-hidden
      data-slot="phase-swatch"
      data-state={state}
      className={cn(
        'flex size-3.5 shrink-0 items-center justify-center rounded-[4px]',
        'transition-[background-color,border-color] duration-quick ease-out motion-reduce:transition-none',
        state === 'done' && 'bg-foreground text-background',
        state === 'active' && 'border-2 border-foreground bg-card',
        state === 'active' && pulse && 'animate-pulse motion-reduce:animate-none',
        state === 'pending' && 'bg-border',
        className,
      )}
    >
      {state === 'done' && <Check className="size-2.5" strokeWidth={3} aria-hidden />}
    </span>
  )
}

export interface PhaseRailProps {
  steps: readonly PhaseRailStep[]
  /** Accessible name for the rail, e.g. „Phasen". */
  label: string
  /** The run is live: the active swatch pulses. Off on a terminal run. */
  pulse?: boolean
  className?: string
}

export function PhaseRail({ steps, label, pulse = false, className }: PhaseRailProps): JSX.Element {
  return (
    <ol
      aria-label={label}
      data-slot="phase-rail"
      // On a phone five labels do not fit one row, so the rail wraps and the
      // hairline connectors — which only make sense on one line — wait for `sm`.
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:flex-nowrap sm:gap-x-0', className)}
    >
      {steps.map((step, index) => (
        <li
          key={step.key}
          data-state={step.state}
          aria-current={step.state === 'active' ? 'step' : undefined}
          className="flex items-center gap-1.5 sm:flex-1"
        >
          <PhaseSwatch state={step.state} pulse={pulse} />
          {/* The label never truncates: it is a single word the rail exists to
              show, and the connector beside it is what gives way. */}
          <span
            className={cn(
              'whitespace-nowrap text-xs leading-none',
              step.state === 'active' && 'font-semibold text-foreground',
              step.state === 'done' && 'text-foreground',
              step.state === 'pending' && 'text-muted-foreground',
            )}
          >
            {step.label}
          </span>
          <span className="sr-only">{step.stateLabel}</span>
          {index < steps.length - 1 && (
            <span
              aria-hidden
              className={cn(
                'mx-2 hidden h-px min-w-3 flex-1 sm:block',
                step.state === 'done' ? 'bg-foreground/30' : 'bg-border',
              )}
            />
          )}
        </li>
      ))}
    </ol>
  )
}
