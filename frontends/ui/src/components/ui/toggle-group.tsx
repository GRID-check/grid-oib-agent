'use client'

import * as React from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { toggleVariants } from '@/components/ui/toggle'
import { motion, springGlide } from '@/components/motion'

type ToggleGroupContextValue = VariantProps<typeof toggleVariants> & {
  segmented: boolean
  /** The group's current value (single string or multiple array), or undefined
   * when nothing is selected — so a segmented item can tell whether IT is the
   * active one and mount the shared-layout pill. */
  groupValue: string | string[] | undefined
}

const ToggleGroupContext = React.createContext<ToggleGroupContextValue>({
  size: 'default',
  variant: 'default',
  segmented: false,
  groupValue: undefined,
})

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> &
    VariantProps<typeof toggleVariants> & {
      /** Joined segment cluster (view switcher). */
      segmented?: boolean
    }
>(
  (
    {
      className,
      variant,
      size,
      segmented = false,
      children,
      value,
      defaultValue,
      onValueChange,
      ...props
    },
    ref
  ) => {
    // Same plumbing as `Tabs`: controlled (`value`) and uncontrolled
    // (`defaultValue`) alike, so the segmented pill follows clicks exactly the
    // way Radix's own `data-state` does. No `type="multiple"` consumer exists
    // today, but the context carries the array form anyway so the check below
    // stays total.
    type Value = string | string[] | undefined
    const [uncontrolled, setUncontrolled] = React.useState<Value>(defaultValue)
    const resolved: Value = value !== undefined ? value : uncontrolled
    const handleValueChange = React.useCallback(
      (next: string | string[]) => {
        if (value === undefined) setUncontrolled(next)
        ;(onValueChange as ((next: string | string[]) => void) | undefined)?.(next)
      },
      [value, onValueChange]
    )
    // `value` + `onValueChange` re-attached after the spread so the plumbing
    // above wins; `defaultValue` rides along only while uncontrolled.
    const rootProps = {
      ...props,
      value: resolved,
      onValueChange: handleValueChange,
      ...(value === undefined ? { defaultValue } : null),
    } as React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
    return (
      <ToggleGroupPrimitive.Root
        ref={ref}
        data-slot="toggle-group"
        className={cn(
          'flex items-center',
          segmented
            ? 'gap-0 rounded-lg border border-border bg-card p-0.5 shadow-2xs'
            : 'flex-wrap gap-1.5',
          className
        )}
        {...rootProps}
      >
        <ToggleGroupContext.Provider
          value={{ variant, size, segmented, groupValue: resolved }}
        >
          {children}
        </ToggleGroupContext.Provider>
      </ToggleGroupPrimitive.Root>
    )
  }
)
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName

/**
 * The segmented pill's surface per toggle variant — the exact on-state fill
 * each variant wore before (`toggleVariants`), lifted onto the travelling
 * element. Non-segmented groups never render it and are untouched.
 */
const SEGMENTED_PILL_BG: Record<string, string> = {
  default: 'bg-accent',
  outline: 'bg-card',
  inverted: 'bg-foreground',
}

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>
>(({ className, children, variant, size, value, ...props }, ref) => {
  const context = React.useContext(ToggleGroupContext)
  const resolvedVariant = context.variant ?? variant ?? 'default'
  const isActive =
    context.segmented &&
    value !== undefined &&
    (Array.isArray(context.groupValue)
      ? context.groupValue.includes(value)
      : context.groupValue === value)
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      value={value}
      data-slot="toggle-group-item"
      className={cn(
        toggleVariants({
          variant: context.variant ?? variant,
          size: context.size ?? size,
        }),
        // Segmented only: the on-state SURFACE moves onto the shared-layout
        // pill below, so the item's own on-fill and on-shadow are turned off
        // explicitly (tailwind-merge keeps these over the cva ones) — exactly
        // like the tabs trigger. Only ink stays here. `relative isolate` +
        // pill `-z-10` keeps the text above the pill with no wrapper element,
        // so no consumer needs a relative wrapper of its own.
        context.segmented &&
          'relative isolate data-[state=on]:bg-transparent data-[state=on]:shadow-none',
        className
      )}
      {...props}
    >
      {isActive && (
        <motion.span
          layoutId="toggle-pill"
          aria-hidden
          data-slot="toggle-pill"
          className={cn(
            'absolute inset-0 -z-10 rounded-[inherit] shadow-2xs',
            SEGMENTED_PILL_BG[resolvedVariant] ?? SEGMENTED_PILL_BG.default
          )}
          // Unbounded travel across the segment cluster is why this is
          // `springGlide`; reduced motion is handled by the global
          // `<MotionConfig reducedMotion="user">` in providers.tsx.
          transition={springGlide}
        />
      )}
      {children}
    </ToggleGroupPrimitive.Item>
  )
})
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName

export { ToggleGroup, ToggleGroupItem }
