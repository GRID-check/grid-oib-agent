'use client'

/**
 * Stepper — the horizontal progress rail for a short multi-part form.
 *
 * A long form and a stepped one ask for exactly the same information; what
 * changes is what the person knows while they answer. Three things this shape
 * has to deliver, and each is a line of code below rather than decoration:
 *
 *   - **How far, and how much is left.** A count ("Schritt 2 von 4") is the
 *     single strongest predictor of whether somebody finishes: an unknown
 *     remaining cost is the one people abandon. It is stated in words for
 *     screen readers and drawn as filled circles for everyone else.
 *   - **What is coming.** The labels are visible ahead of time, so the reader
 *     can see that the last step is a review and not another form. A stepper
 *     with numbers and no names is a progress bar wearing a costume.
 *   - **That going back costs nothing.** Every step already visited is a
 *     button. A form that traps you on the step you are on is one people
 *     answer defensively, guessing rather than correcting.
 *
 * Deliberately not a navigation landmark: it is a control for one form, and it
 * carries `aria-current="step"`, which is what tells assistive technology where
 * in the sequence the reader is.
 *
 * Labels hide below `sm` — seven characters across four columns on a phone is
 * a row of abbreviations nobody can read — and the current step's label is
 * stated underneath instead, where there is a full line for it.
 */

import type { JSX } from 'react'
import { Check } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface StepperStep {
  key: string
  label: string
  /**
   * A short word about what is still open on this step, e.g. „2 Befunde".
   *
   * Folded into the circle's accessible NAME rather than shown only under the
   * label, because the label is `aria-hidden` and hidden below `sm` — a marker
   * a screen reader and a phone both miss is a marker that does not exist.
   */
  note?: string
}

export interface StepperProps {
  steps: readonly StepperStep[]
  /** Zero-based index of the step being shown. */
  current: number
  /**
   * Zero-based index of the furthest step reached. Everything up to it is a
   * button; everything past it is inert — a stepper that let a reader jump to
   * the end would be offering a shortcut the form's own validation then takes
   * back, which is worse than not offering it.
   */
  furthest: number
  onSelect: (index: number) => void
  /** Accessible name for the rail, e.g. "Schritte". */
  label: string
  /** "Schritt {current} von {total}", already interpolated by the caller. */
  progressLabel: string
  className?: string
}

export function Stepper({
  steps,
  current,
  furthest,
  onSelect,
  label,
  progressLabel,
  className,
}: StepperProps): JSX.Element {
  return (
    <div className={cn('w-full', className)} data-slot="stepper">
      {/* The count, said once and read by everything. The visual rail below is
          `aria-hidden` for the same reason a chart's data table is the accessible
          copy: eight circles announced one by one is not progress, it is noise. */}
      <p className="sr-only" role="status">
        {progressLabel}
      </p>
      <ol className="flex items-start gap-1" aria-label={label}>
        {steps.map((step, index) => {
          const done = index < current
          const active = index === current
          const reachable = index <= furthest
          return (
            <li key={step.key} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <div className="flex w-full items-center gap-1">
                {/* Connectors on both sides rather than between items, so every
                    circle sits at the exact centre of its column and the rail
                    stays symmetrical however long the labels are. */}
                <span
                  aria-hidden
                  className={cn(
                    'h-px flex-1 rounded-full',
                    index === 0 ? 'opacity-0' : done || active ? 'bg-primary' : 'bg-border',
                  )}
                />
                <button
                  type="button"
                  onClick={() => reachable && onSelect(index)}
                  disabled={!reachable}
                  aria-current={active ? 'step' : undefined}
                  // Numbered, because a bare label is ambiguous twice over: in
                  // a rail of circles it does not say WHERE in the sequence it
                  // is, and a step named after the field it holds („Anweisungen")
                  // is otherwise indistinguishable from that field's own label
                  // to anything querying by accessible name.
                  aria-label={
                    step.note
                      ? `${index + 1}. ${step.label} — ${step.note}`
                      : `${index + 1}. ${step.label}`
                  }
                  className={cn(
                    'focus-visible:ring-ring/60 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums',
                    'transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none',
                    done && 'border-primary bg-primary text-primary-foreground',
                    active && 'border-primary text-primary ring-primary/20 bg-card ring-4',
                    !done && !active && 'border-border text-muted-foreground bg-card',
                    reachable ? 'cursor-pointer' : 'cursor-default',
                  )}
                >
                  {done ? <Check className="size-3.5" aria-hidden /> : index + 1}
                </button>
                <span
                  aria-hidden
                  className={cn(
                    'h-px flex-1 rounded-full',
                    index === steps.length - 1 ? 'opacity-0' : done ? 'bg-primary' : 'bg-border',
                  )}
                />
              </div>
              <span
                aria-hidden
                className={cn(
                  'hidden max-w-full truncate text-center text-[11px] sm:block',
                  active ? 'text-foreground font-medium' : 'text-muted-foreground',
                )}
              >
                {step.label}
              </span>
              {step.note && (
                <span
                  aria-hidden
                  className="text-muted-foreground hidden max-w-full truncate text-center text-[10.5px] sm:block"
                >
                  {step.note}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {/* The phone's substitute for the hidden labels: the step being answered,
          named on a line wide enough to name it. */}
      <p aria-hidden className="text-foreground mt-2 text-center text-sm font-medium sm:hidden">
        {steps[current]?.label}
      </p>
    </div>
  )
}
