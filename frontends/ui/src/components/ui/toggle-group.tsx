'use client'

import * as React from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { toggleVariants } from '@/components/ui/toggle'

type ToggleGroupContextValue = VariantProps<typeof toggleVariants> & {
  segmented: boolean
}

const ToggleGroupContext = React.createContext<ToggleGroupContextValue>({
  size: 'default',
  variant: 'default',
  segmented: false,
})

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> &
    VariantProps<typeof toggleVariants> & {
      /** Joined segment cluster (view switcher). */
      segmented?: boolean
    }
>(({ className, variant, size, segmented = false, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    data-slot="toggle-group"
    className={cn(
      'flex items-center',
      segmented
        ? 'gap-0 rounded-lg border border-border bg-card p-0.5 shadow-2xs'
        : 'flex-wrap gap-1.5',
      className,
    )}
    {...props}
  >
    <ToggleGroupContext.Provider value={{ variant, size, segmented }}>
      {children}
    </ToggleGroupContext.Provider>
  </ToggleGroupPrimitive.Root>
))
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>
>(({ className, children, variant, size, ...props }, ref) => {
  const context = React.useContext(ToggleGroupContext)
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      data-slot="toggle-group-item"
      className={cn(
        toggleVariants({
          variant: context.variant ?? variant,
          size: context.size ?? size,
        }),
        context.segmented && 'data-[state=on]:shadow-2xs',
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
})
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName

export { ToggleGroup, ToggleGroupItem }
