'use client'

/**
 * The panel half of {@link useHoverPopover}: a popover that exists only once
 * its trigger has been engaged, and that sits BESIDE the trigger rather than
 * around it.
 *
 * Both halves of that sentence are load-bearing.
 *
 * Lazy, because the triggers are everywhere. Every citation chip, `[N]` marker,
 * file reference and @-mention used to wrap itself in a Radix `Popover` up
 * front, and a closed one is not free: Popper, Presence, the anchor's layout
 * effects and a handful of context subscriptions, per chip. Opening a
 * twenty-message conversation spent a follow-up commit of ~1,500 fibers on
 * panels nobody had asked for. Before engagement this renders `null`.
 *
 * Beside, because mounting the popover around the trigger at engagement would
 * move the trigger in the React tree — `<button>` becomes
 * `<Popover><PopoverAnchor><button>` — and React remounts an element whose
 * position changes. The focus that engaged it would go to a detached node, and
 * on touch the remount lands between `pointerdown` and `click`, so the tap is
 * swallowed. The trigger renders first and never moves; this renders after it
 * and anchors to it by ref (`PopoverAnchor virtualRef`), so the DOM the reader
 * touches is the same node before and after.
 *
 * Usage: spread `peek.triggerProps` on the trigger (it carries the ref), then
 * render `<HoverPeekPanel peek={peek}>…</HoverPeekPanel>` as its next sibling.
 */

import type { FC, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { HoverPopover } from '@/hooks/use-hover-popover'

/**
 * The gutter a peek keeps from the viewport edge, matching the phone's 12px
 * page inset. Radix's default is 0, so a 320px panel anchored to a marker near
 * the right edge of a 390px screen was pushed flush against the glass, and one
 * wider than the screen was cut off. Applied twice: as `collisionPadding`, so
 * Radix shifts the panel in from the edge, and as the `max-w` cap, so a panel
 * wider than the viewport shrinks to fit instead of being shifted off the
 * other side.
 */
const VIEWPORT_GUTTER_PX = 12

export const HoverPeekPanel: FC<{
  peek: HoverPopover
  className?: string
  align?: 'start' | 'center' | 'end'
  children: ReactNode
}> = ({ peek, className, align = 'start', children }) => {
  if (!peek.engaged) return null
  return (
    <Popover open={peek.open} onOpenChange={peek.onOpenChange}>
      <PopoverAnchor virtualRef={peek.anchorRef} />
      <PopoverContent
        align={align}
        collisionPadding={VIEWPORT_GUTTER_PX}
        className={cn(
          'max-w-[calc(100vw-24px)]',
          className,
          // Replaced by the next peek (see `useHoverPopover`): gone in the
          // frame the next one arrives, rather than fading out underneath it.
          // Important, because `animate-out` sits under the same variant and
          // wins the cascade otherwise.
          peek.skipExit && 'data-[state=closed]:animate-none!'
        )}
        {...peek.contentProps}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
