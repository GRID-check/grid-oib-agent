'use client'

/**
 * The floating card of a guided tour: one stop's title and body, where the
 * reader is in the tour, and the controls to move through it.
 *
 * A molecule, and deliberately domain-free. It knows nothing about which tour
 * it belongs to or which library positions it — the product tour
 * (`features/onboarding/components/product-tour.tsx`) hands it copy and
 * callbacks, and the positioning library places it. Anything that wants a
 * second tour composes this card rather than restyling the library's default.
 *
 * It is a floating panel, so it takes the floating radius (`rounded-xl`) and
 * the popover surface, the same material as a Popover or a Dialog. The primary
 * action is ink like every other primary action; progress is a row of quiet
 * dashes rather than a coloured bar, because nothing about "stop 3 of 5" is a
 * signal worth chroma.
 *
 * Focus moves to the primary button whenever the stop changes, so a keyboard
 * reader can walk the tour with Enter alone. The positioning library owns the
 * arrow keys and Escape.
 */

import * as React from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface TourCardLabels {
  next: string
  back: string
  done: string
  close: string
  /** "2 of 5", already interpolated. */
  progress: string
}

export interface TourCardProps {
  title: string
  children: React.ReactNode
  /** Zero-based index of the current stop. */
  step: number
  total: number
  labels: TourCardLabels
  /** Advances, or finishes the tour on the last stop. */
  onNext: () => void
  onBack: () => void
  /** Leaves the tour early. */
  onClose: () => void
  className?: string
}

export function TourCard({
  title,
  children,
  step,
  total,
  labels,
  onNext,
  onBack,
  onClose,
  className,
}: TourCardProps): JSX.Element {
  const titleId = React.useId()
  const bodyId = React.useId()
  const primaryRef = React.useRef<HTMLButtonElement>(null)
  const isFirst = step === 0
  const isLast = step >= total - 1

  React.useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true })
  }, [step])

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className={cn(
        'bg-popover text-popover-foreground w-[min(22rem,calc(100vw-2rem))] rounded-xl border p-5 shadow-lg',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider tabular-nums">
          {labels.progress}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={labels.close}
          className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/60 touch-target -m-1.5 flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      <h2 id={titleId} className="mt-1.5 text-sm font-semibold">
        {title}
      </h2>
      <div id={bodyId} className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
        {children}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <TourProgress step={step} total={total} />
        <div className="flex items-center gap-2">
          {!isFirst && (
            <Button type="button" variant="ghost" size="sm" onClick={onBack}>
              {labels.back}
            </Button>
          )}
          <Button ref={primaryRef} type="button" size="sm" onClick={onNext}>
            {isLast ? labels.done : labels.next}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** One dash per stop; the current one is ink, the visited ones half ink. */
function TourProgress({ step, total }: { step: number; total: number }): JSX.Element {
  return (
    <div className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={cn(
            'h-1 rounded-full transition-colors duration-base ease-out motion-reduce:transition-none',
            index === step ? 'bg-foreground w-4' : 'w-1.5',
            index < step && 'bg-foreground/40',
            index > step && 'bg-foreground/15',
          )}
        />
      ))}
    </div>
  )
}
