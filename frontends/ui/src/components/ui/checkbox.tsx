'use client'

import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { CheckIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    data-slot="checkbox"
    className={cn(
      'peer border-input dark:bg-input-dark data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary size-4 shrink-0 rounded-sm border outline-none transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50',
      'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
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
