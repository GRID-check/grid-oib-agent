'use client'

import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

import { cn } from '@/lib/utils'
import { OVERLAY_EXIT, OVERLAY_REDUCED } from '@/components/ui/overlay-motion'

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
}

const Tooltip = ({ ...props }: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>) => (
  <TooltipProvider>
    <TooltipPrimitive.Root data-slot="tooltip" {...props} />
  </TooltipProvider>
)

/**
 * Opens on hover, and on focus only when the focus is one a keyboard user can
 * see (`:focus-visible`).
 *
 * Radix opens a tooltip on every focus event. A popover or dialog moves focus
 * to its first focusable element when it opens and back to its trigger when it
 * closes, so a help icon placed first in a popover showed its tooltip the
 * moment a click opened the popover. The browser already tells the two apart:
 * focus that follows a pointer click does not match `:focus-visible`, focus
 * reached with Tab does. Cancelling the event is how Radix's composed handler
 * is told to skip opening; focus itself is not cancelable, so nothing else
 * changes.
 */
const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ onFocus, ...props }, ref) => (
  <TooltipPrimitive.Trigger
    ref={ref}
    data-slot="tooltip-trigger"
    onFocus={(event) => {
      onFocus?.(event)
      if (!isFocusVisible(event.currentTarget)) event.preventDefault()
    }}
    {...props}
  />
))
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    // An engine without the selector keeps Radix's open-on-focus.
    return true
  }
}

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        'bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs font-medium text-balance shadow-xs '
        + `duration-base ease-entrance ${OVERLAY_EXIT} ${OVERLAY_REDUCED}`,
        className
      )}
      {...props}
    >
      {children}
      <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45" />
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
