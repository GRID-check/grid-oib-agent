'use client'

import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { CheckIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    data-slot="checkbox"
    className={cn(
      // 16px is the right SIZE for a checkbox and a hopeless touch target, so
      // the box keeps its size and `touch-target` widens what a tap resolves to.
      // CHECKED IS GREEN, and that is the whole rule for this family: the box
      // at rest is a hairline, the box that is ON carries the accent. Ink is
      // reserved for things you press (see tokens.css) — a checkbox is not
      // pressed, it is *set*, so it takes the colour of state, not of action.
      'peer border-input dark:bg-input-dark data-[state=checked]:bg-brand data-[state=checked]:text-brand-foreground data-[state=checked]:border-brand size-4 shrink-0 rounded-sm border outline-none transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50 touch-target',
      // `dark:bg-input-dark` and `data-[state=checked]:bg-brand` have equal
      // specificity, and the dark variant is emitted last — so in dark mode a
      // CHECKED box kept the unchecked fill and drew its dark tick on it,
      // which is invisible. Re-assert the checked fill under `dark:` so the
      // two conditions compose instead of one silently winning.
      'dark:data-[state=checked]:bg-brand dark:data-[state=checked]:text-brand-foreground',
      FOCUS_RING,
      'aria-invalid:ring-destructive/20 aria-invalid:border-destructive',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      data-slot="checkbox-indicator"
      className="flex items-center justify-center text-current transition-none"
    >
      <CheckIcon className="size-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
