'use client'

import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { motion, springGlide } from '@/components/motion'

/**
 * The selected tab, as Radix sees it — plumbed through context so each trigger
 * can tell whether IT is the active one and mount the shared-layout pill.
 * Controlled (`value`) and uncontrolled (`defaultValue`) alike: when `value`
 * is absent the wrapper tracks `onValueChange` into local state, so the pill
 * follows clicks exactly the way Radix's own `data-state` does.
 */
const TabsValueContext = React.createContext<string | undefined>(undefined)

const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ className, value, defaultValue, onValueChange, children, ...props }, ref) => {
  const [uncontrolled, setUncontrolled] = React.useState<string | undefined>(defaultValue)
  const resolved = value !== undefined ? value : uncontrolled
  const handleValueChange = React.useCallback(
    (next: string) => {
      if (value === undefined) setUncontrolled(next)
      onValueChange?.(next)
    },
    [value, onValueChange]
  )
  return (
    <TabsPrimitive.Root
      ref={ref}
      data-slot="tabs"
      className={cn('flex flex-col gap-2', className)}
      value={resolved}
      onValueChange={handleValueChange}
      {...props}
    >
      <TabsValueContext.Provider value={resolved}>{children}</TabsValueContext.Provider>
    </TabsPrimitive.Root>
  )
})
Tabs.displayName = TabsPrimitive.Root.displayName

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    data-slot="tabs-list"
    className={cn(
      // Under a finger the strip is sized by its triggers (which carry the
      // 44px floor) rather than by a fixed height that a caller's `h-*` could
      // silently undercut — see the Button size comment for why `pointer-coarse`.
      'bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-1 pointer-coarse:h-auto',
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, value, children, ...props }, ref) => {
  const activeValue = React.useContext(TabsValueContext)
  const isActive = value !== undefined && activeValue === value
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      data-slot="tabs-trigger"
      className={cn(
        // The active SURFACE lives on the shared-layout pill below, so the
        // trigger paints none of its own — no `data-[state=active]:bg-card`,
        // no active shadow — exactly like the sidebar rail. Only the INK stays
        // here (an ink-only color tween plus the snap press dip, mirroring the
        // Button press split); the surface glides on `springGlide`.
        // `relative isolate` + pill `-z-10`: the pill paints above the list's
        // own background but below the trigger's text and icons, with no
        // wrapper element to disturb the trigger's flex layout.
        'data-[state=active]:text-foreground outline-none relative isolate inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-md px-3.5 py-1 text-sm font-medium whitespace-nowrap transition-[color,transform] [transition-duration:var(--motion-quick),var(--motion-snap)] ease-out motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11 active:scale-[0.98] motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
        FOCUS_RING,
        className
      )}
      {...props}
    >
      {isActive && (
        <motion.span
          layoutId="tabs-pill"
          aria-hidden
          data-slot="tabs-pill"
          // The exact chip the active trigger wore before — `bg-card shadow-xs`
          // — lifted onto its own element so it can travel. Unbounded travel
          // (adjacent tabs or across the strip) is why this is `springGlide`
          // and not an overshooting spring; reduced motion is handled by the
          // global `<MotionConfig reducedMotion="user">` in providers.tsx.
          className="bg-card shadow-xs absolute inset-0 -z-10 rounded-[inherit]"
          transition={springGlide}
        />
      )}
      {children}
    </TabsPrimitive.Trigger>
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    data-slot="tabs-content"
    className={cn('flex-1 outline-none', className)}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
