import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * CountPill — the small, soft rounded-full micro-badge that sits beside a
 * heading to carry a count or ratio ("5 Dokumente", "3/8 erfasst"). It is a
 * static, non-interactive label: use it when a heading needs a quiet numeric
 * companion.
 *
 * Distinct from {@link import('./chip').Chip}, which is the interactive,
 * variant-driven pill for clickable affordances (filters, tool tags, sources).
 * When you need hover/focus/click behaviour or a semantic colour, reach for
 * `Chip`; when you just need the muted count next to a title, reach for this.
 *
 * The project brief and the surfaced-document grid card both hand-rolled this
 * identical span (and had already drifted on padding); it lives here once.
 */
const CountPill = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      data-slot="count-pill"
      className={cn(
        'inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground',
        className
      )}
      {...props}
    />
  )
)
CountPill.displayName = 'CountPill'

export { CountPill }
