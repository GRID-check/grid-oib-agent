'use client'

import * as React from 'react'
import * as TogglePrimitive from '@radix-ui/react-toggle'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'

const toggleVariants = cva(
  // One radius for the whole scale (`rounded-md`, 8px): the `inverted` variant
  // used to override the base with `rounded-lg`, so two toggles sitting in the
  // same filter row rounded differently depending on which variant they were.
  // 8px is also what nests correctly inside the segmented group's `rounded-lg`
  // tray — an item as round as its container reads as a bulge.
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors duration-200 ease-out outline-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 motion-reduce:transition-none " +
    FOCUS_RING,
  {
    variants: {
      variant: {
        default: 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground',
        outline:
          'border border-border bg-transparent text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground data-[state=on]:border-border data-[state=on]:bg-card data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-xs',
        inverted:
          'text-muted-foreground hover:bg-accent hover:text-foreground data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:shadow-2xs',
      },
      // Aligned to `Button`'s size scale, one name = one height, so a toggle
      // and a button placed side by side in a toolbar line up. The scale used
      // to sit one step low (Toggle `default` was Button `sm`), which is why
      // every filter row next to a button read a notch short.
      size: {
        default: 'h-9 px-3 text-[13px] pointer-coarse:h-11',
        sm: 'h-8 px-3 text-[12.5px] pointer-coarse:h-11',
        lg: 'h-10 px-3.5 pointer-coarse:h-11',
        // Icon sizes are the glyph's own square and are NOT part of that
        // remap — they pair with `Button size="icon"` by area, not by height.
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
