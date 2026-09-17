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
 * square with a check in it, the live phase is the same square as a ring, and a
 * pending phase is the square in border grey. The ring is STATIC: the surface
 * that owns this rail already runs its one ambient loop in its header, and a
 * second one here would be two things breathing at different rates. Colour
 * never travels alone: the label beside each swatch carries the state in weight
 * (bold for live, ink for done, muted for pending), the live step carries
 * `aria-current="step"`, and a visually-hidden word states the state for
 * readers who see none of the above.
 *
 * ## What moves, and only when the state moves
 *
 * The rail knows nothing about what the phases are; it animates CHANGES of
 * `data-state`, which is the one thing it does know.
 *
 * - A swatch turning `done` fills over `duration-quick` and its check draws in
 *   on `springSnap` — a 4px travel, well inside the spring's 24px ceiling, and
 *   earned: the flip is a state the reader has been waiting for.
 * - The connector after a done step fills left to right: a `scaleX` transform
 *   driven by `data-state`, so it runs on the same render that flipped the
 *   state and needs no timer.
 * - On `arrive`, the swatches fade in one after another (opacity only, capped
 *   at `staggerMaxSteps`), the cue that this rail just appeared as a whole.
 *
 * A swatch that MOUNTS done draws nothing: `AnimatePresence initial={false}`
 * blocks the check's entrance on the first render, so a block reloaded in a
 * finished state paints its rail in one frame. Under reduced motion every one
 * of these is the change with no motion (`motionInstant`, and the CSS side's
 * `motion-reduce:` variants).
 *
 * `PhaseSwatch` is exported on its own so the vertical phase list under the rail
 * can mark its rows with the same square; a rail and a list that drew two
 * different "done" marks would be two lookalikes on one surface.
 */

'use client'

import type { CSSProperties } from 'react'
import { Check } from 'lucide-react'

import {
  AnimatePresence,
  motion,
  motionInstant,
  motionQuick,
  springSnap,
  staggerMaxSteps,
  staggerStepSeconds,
} from '@/components/motion'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
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
  /**
   * Fade in on mount after this many seconds (opacity only). Undefined paints
   * the swatch in place — the default, and the only right answer for a swatch
   * inside something that already animated its own arrival.
   */
  arriveDelay?: number
  className?: string
}

/** The check's entrance: scale is the snap, opacity a plain quick tween. */
const CHECK_HIDDEN = { scale: 0.6, opacity: 0 }
const CHECK_SHOWN = { scale: 1, opacity: 1 }

/**
 * The status square, sized so the check inside it is a check rather than a
 * smudge: 14px, not the title-line swatch's 10px, because this one has a glyph
 * to hold. Same radius family, same ink, so it still reads as that square.
 */
export function PhaseSwatch({ state, arriveDelay, className }: PhaseSwatchProps): JSX.Element {
  const reduced = useReducedMotion()
  const arriving = arriveDelay !== undefined && !reduced
  return (
    <span
      aria-hidden
      data-slot="phase-swatch"
      data-state={state}
      className={cn(
        'flex size-3.5 shrink-0 items-center justify-center rounded-[4px]',
        'transition-[background-color,border-color] duration-quick ease-out motion-reduce:transition-none',
        arriving && 'animate-in fade-in-0 duration-quick ease-out [animation-fill-mode:backwards] motion-reduce:animate-none',
        state === 'done' && 'bg-foreground text-background',
        state === 'active' && 'border-2 border-foreground bg-card',
        state === 'pending' && 'bg-border',
        className,
      )}
      style={arriving ? ({ animationDelay: `${arriveDelay}s` } satisfies CSSProperties) : undefined}
    >
      <AnimatePresence initial={false}>
        {state === 'done' && (
          <motion.span
            key="check"
            className="flex"
            initial={CHECK_HIDDEN}
            animate={CHECK_SHOWN}
            transition={reduced ? motionInstant : { scale: springSnap, opacity: motionQuick }}
          >
            <Check className="size-2.5" strokeWidth={3} aria-hidden />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}

export interface PhaseRailProps {
  steps: readonly PhaseRailStep[]
  /** Accessible name for the rail, e.g. „Phasen". */
  label: string
  /**
   * The rail is arriving with its surface: the swatches fade in left to right.
   * Off for a rail the reader revealed by hand, which is already on screen.
   */
  arrive?: boolean
  className?: string
}

export function PhaseRail({ steps, label, arrive = false, className }: PhaseRailProps): JSX.Element {
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
          <PhaseSwatch
            state={step.state}
            arriveDelay={arrive ? Math.min(index, staggerMaxSteps) * staggerStepSeconds : undefined}
          />
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
            // The grey hairline is always drawn; the ink fill on top of it
            // scales in from the left when the step is done, and back out
            // (never in practice — a phase does not un-finish) if it is not.
            <span aria-hidden className="relative mx-2 hidden h-px min-w-3 flex-1 bg-border sm:block">
              <span
                data-slot="phase-connector"
                data-state={step.state}
                className="absolute inset-0 origin-left scale-x-0 bg-foreground/30 transition-transform duration-base ease-out data-[state=done]:scale-x-100 motion-reduce:transition-none"
              />
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}
