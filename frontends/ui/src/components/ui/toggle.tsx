'use client'

import * as React from 'react'
import * as TogglePrimitive from '@radix-ui/react-toggle'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors duration-200 ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 motion-reduce:transition-none",
  {
    variants: {
      variant: {
        default: 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground',
        outline:
          'border border-border bg-transparent text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground data-[state=on]:border-border data-[state=on]:bg-card data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-xs',
        inverted:
          'rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:shadow-2xs',
      },
      size: {
        default: 'h-8 px-3 text-[13px] pointer-coarse:h-11',
        sm: 'h-7 px-3 text-[12.5px] pointer-coarse:h-11',
        lg: 'h-9 px-3.5 pointer-coarse:h-11',
        icon: 'size-8 pointer-coarse:size-11',
        'icon-sm': 'size-7 px-0 pointer-coarse:size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

const Toggle = React.forwardRef<
  React.ElementRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(({ className, variant, size, ...props }, ref) => (
  <TogglePrimitive.Root
    ref={ref}
    data-slot="toggle"
    className={cn(toggleVariants({ variant, size, className }))}
    {...props}
  />
))
Toggle.displayName = TogglePrimitive.Root.displayName

export { Toggle, toggleVariants }
