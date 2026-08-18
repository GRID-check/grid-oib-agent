import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Physical keycap. Hairline edge + raised surface + contact shadow so a
 * shortcut looks like a key, not like muted text. Used by the cheatsheet,
 * the command palette, and picker footers.
 */
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>): React.JSX.Element {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-[7px] px-1.5',
        'border border-border bg-surface-raised shadow-xs',
        'font-mono text-[11px] leading-none font-medium text-foreground whitespace-nowrap tabular-nums',
        'pointer-events-none select-none',
        '[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background',
        className,
      )}
      {...props}
    />
  )
}

/** Groups a chord or a sequence of keycaps (⌘ K, G then F). */
function KbdGroup({ className, ...props }: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
