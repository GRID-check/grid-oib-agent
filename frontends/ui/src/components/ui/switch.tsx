'use client'

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@/lib/utils'

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    data-slot="switch"
    className={cn(
      // The track is 40×24 by design; `touch-target` gives the finger 44×44
      // over it without turning a settings row into a row of buttons.
      'peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-transparent transition-colors duration-200 outline-none disabled:cursor-not-allowed disabled:opacity-50 touch-target',
      'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      className={cn(
        'pointer-events-none block size-5 rounded-full bg-background shadow-sm ring-0 transition-transform duration-200 ease-out data-[state=checked]:translate-x-[1.125rem] data-[state=unchecked]:translate-x-0.5'
      )}
    />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName

export { Switch }
