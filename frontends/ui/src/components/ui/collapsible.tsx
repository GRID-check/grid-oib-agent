'use client'

import * as React from 'react'
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'

import { cn } from '@/lib/utils'

const Collapsible = CollapsiblePrimitive.Root

const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger

/**
 * Animated collapsible body — opacity keyframes, owned once here.
 *
 * Why keyframes and not the `grid-rows-[0fr]→[1fr]` transition: two structural
 * facts about this primitive's consumers forbid it. (1) Radix `Presence` only
 * suspends unmount for CSS *animations* (see `usePresence` in
 * `@radix-ui/react-presence` — it tracks `animationName`, never transitions),
 * so a pure transition closes by unmounting instantly, and a freshly mounted
 * open node paints at `1fr` on its first frame, so the open transition never
 * runs either — the transition form animates only a re-open mid-close.
 * (2) The grid form needs the collapsing element itself to be the grid with a
 * `min-h-0 overflow-hidden` single item; several consumers put multi-child
 * `flex` layouts, padding and borders directly on `CollapsibleContent`, which
 * a grid transition either no-ops on (flex — a freeze-then-vanish lag) or
 * leaves slivers of. An opacity keyframe pair composes with every consumer
 * layout (fade-in utilities included — the unlayered rule below wins the
 * `animation`-shorthand conflict by specificity and source order), suspends
 * unmount on close, and unmounts to zero space afterwards, so a closed panel
 * still occupies nothing.
 *
 * Timings mirror the overlay pair (`overlay-motion.ts`): the entrance runs the
 * base duration on the entrance curve, the exit one step shorter on the exit
 * curve. No animation on initial mount in practice: no consumer mounts this
 * open (all are controlled `open={…}` starting closed), so every play follows
 * a user gesture — a user-initiated expand, never layout motion.
 */
const CollapsibleContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(({ className, ...props }, ref) => (
  <CollapsiblePrimitive.CollapsibleContent
    ref={ref}
    data-slot="collapsible-content"
    className={cn(
      // Open/close keyframes live in globals.css (unlayered, after
      // tw-animate-css, so they win over ad-hoc `animate-in` on consumers).
      // `motion-reduce:animate-none` is belt to the media-query guard there;
      // the global reduced-motion block collapses the durations regardless.
      'motion-reduce:animate-none',
      className
    )}
    {...props}
  />
))
CollapsibleContent.displayName = CollapsiblePrimitive.CollapsibleContent.displayName

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
