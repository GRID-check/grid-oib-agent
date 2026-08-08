'use client'

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * Chip — a small, reusable inline pill for lightweight agent affordances
 * (memory "Piloti noted N", source counts, tool tags, filters, …).
 *
 * Composable and design-system-aligned:
 * - `variant` picks a semantic token pair (muted / success / warning / info / …).
 * - `interactive` adds hover + focus affordances so a chip can be a button or a
 *   popover/tooltip trigger; combine with `asChild` to render as the trigger's
 *   own element (Radix `Trigger asChild`, an `<a>`, etc.) without nesting.
 * - Any leading icon and a trailing `<ChipCount>` compose as children.
 *
 * Deliberately more capable than `Badge` (which is a static status label): a
 * Chip is meant to be clicked, counted, and reused across features.
 */
const chipVariants = cva(
  'inline-flex items-center gap-1 rounded-md border font-medium w-fit whitespace-nowrap shrink-0 ' +
    'align-middle transition-[color,background-color,box-shadow] ' +
    '[&>svg]:pointer-events-none [&>svg]:shrink-0 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/10 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
        success: 'border-transparent bg-success-subtle text-success',
        warning: 'border-transparent bg-warning-subtle text-warning',
        info: 'border-transparent bg-info-subtle text-info',
        destructive: 'border-transparent bg-danger-subtle text-error',
      },
      size: {
        sm: 'h-5 px-2 text-[11px] [&>svg]:size-3',
        md: 'h-6 px-2.5 text-xs [&>svg]:size-3.5',
      },
      // A chip that can be tapped needs a finger-sized catchment, but a 44px-tall
      // chip is not a chip any more — the small size IS the signal that it is a
      // secondary affordance. `touch-target` widens the hit area and leaves the
      // pill alone; a non-interactive chip is not a target and gets nothing.
      interactive: {
        true: 'cursor-pointer hover:brightness-95 active:brightness-90 dark:hover:brightness-125 touch-target',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'muted',
      size: 'md',
      interactive: false,
    },
  }
)

export interface ChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof chipVariants> {
  /** Render as the child element (e.g. a Popover/Tooltip trigger or an anchor). */
  asChild?: boolean
}

const Chip = React.forwardRef<HTMLSpanElement, ChipProps>(
  ({ className, variant, size, interactive, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'span'
    return (
      <Comp
        data-slot="chip"
        ref={ref}
        className={cn(chipVariants({ variant, size, interactive, className }))}
        {...props}
      />
    )
  }
)
Chip.displayName = 'Chip'

/** A count pill for the trailing edge of a Chip (e.g. "Piloti noted · 3"). */
const ChipCount = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      data-slot="chip-count"
      className={cn(
        'inline-flex min-w-4 items-center justify-center rounded-full bg-foreground/10 px-1 text-[10px] font-semibold tabular-nums',
        className
      )}
      {...props}
    />
  )
)
ChipCount.displayName = 'ChipCount'

export { Chip, ChipCount, chipVariants }
