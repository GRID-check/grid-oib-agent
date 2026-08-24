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
      'peer border-input dark:bg-input-dark data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary size-4 shrink-0 rounded-sm border outline-none transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50 touch-target',
      // `dark:bg-input-dark` and `data-[state=checked]:bg-primary` have equal
      // specificity, and the dark variant is emitted last — so in dark mode a
      // CHECKED box kept the unchecked fill and drew its dark tick on it,
      // which is invisible. Re-assert the checked fill under `dark:` so the
      // two conditions compose instead of one silently winning.
      'dark:data-[state=checked]:bg-primary dark:data-[state=checked]:text-primary-foreground',
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
