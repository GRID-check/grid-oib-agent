'use client'

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { springSnapLinear, springSnapLinearDuration } from '@/components/motion'

/**
 * The thumb's detent.
 *
 * Travel is 16px (`translate-x-0.5` → `translate-x-[1.125rem]`, i.e. 2px → 18px),
 * which is direct manipulation landing on a discrete stop — the textbook case
 * for `springSnap` (design language, "when a spring is earned": CONTINUATION,
 * the toggle completing the gesture the finger just made). 6.4% of 16px is
 * **1.0px of overshoot** — inside the 1–2px budget, and comfortably under the
 * spring's 24px travel ceiling.
 *
 * Radix drives this through `data-[state]` on a plain element, so the spring has
 * to be the CSS `linear()` sampling rather than the JS spring. It rides inline
 * so it cannot lose a cascade race with the `ease-out` fallback below it: an
 * engine without `linear()` support drops the inline declaration as invalid and
 * the class's `ease-out` stands, which is the documented degrade path.
 */
const THUMB_SPRING: React.CSSProperties = {
  transitionTimingFunction: springSnapLinear,
  transitionDuration: springSnapLinearDuration,
}

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
      // The TRACK is colour, and colour never springs — an overshooting colour
      // lands outside its token. Plain tween, on the default duration.
      // The press dip is transform-only at snap (no layout shift); the track
      // had no reduced-motion guard on its own transition, so it gains one
      // alongside the scale guard.
      'peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-transparent transition-[color,background-color,border-color,transform] [transition-duration:var(--motion-quick),var(--motion-quick),var(--motion-quick),var(--motion-snap)] ease-out outline-none disabled:cursor-not-allowed disabled:opacity-50 touch-target active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100',
      FOCUS_RING,
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      data-slot="switch-thumb"
      style={THUMB_SPRING}
      className={cn(
        'pointer-events-none block size-5 rounded-full bg-background shadow-sm ring-0 transition-transform duration-quick ease-out data-[state=checked]:translate-x-[1.125rem] data-[state=unchecked]:translate-x-0.5 motion-reduce:transition-none'
      )}
    />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName

export { Switch }
