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
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { HoverPopover } from '@/hooks/use-hover-popover'

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
      <PopoverContent align={align} className={className} {...peek.contentProps}>
        {children}
      </PopoverContent>
    </Popover>
  )
}
