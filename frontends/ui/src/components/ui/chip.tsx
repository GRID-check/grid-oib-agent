'use client'

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { CountPill } from '@/components/ui/count-pill'
import { FOCUS_RING } from '@/components/ui/focus-ring'

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
    'align-middle outline-none transition-[transform,opacity] duration-quick ease-out ' +
    'motion-reduce:transition-none [&>svg]:pointer-events-none [&>svg]:shrink-0 ' +
    FOCUS_RING,
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
      // A disabled chip has to say so, and it is routinely `asChild` an anchor
      // or a Radix trigger — neither of which honours `disabled` — so the
      // `aria-disabled` mirror carries the same treatment as the real attribute.
      interactive: {
        true:
          'cursor-pointer touch-target hover:brightness-95 active:brightness-90 dark:hover:brightness-125 active:scale-[0.98] motion-reduce:active:scale-100 ' +
          'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 ' +
          'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
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

/**
 * A count pill for the trailing edge of a Chip (e.g. "Piloti noted \u00b7 3").
 *
 * It IS {@link CountPill} — the design language's one rounded-full numeric pill
 * — not a second shape with its own padding and min-width, which is what this
 * used to be. The only thing it overrides is the fill: `CountPill`'s `bg-muted`
 * would vanish on a `muted` chip (the default), so the count rides on the chip's
 * own ink at 10% and inherits the chip's text colour, and it therefore reads on
 * every chip variant instead of only the ones that happen not to be muted.
 */
const ChipCount = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <CountPill
      ref={ref}
      data-slot="chip-count"
      className={cn('bg-foreground/10 font-semibold text-inherit', className)}
      {...props}
    />
  )
)
ChipCount.displayName = 'ChipCount'

export { Chip, ChipCount, chipVariants }
