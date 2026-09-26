import type { FC } from 'react'

import { cn } from '@/lib/utils'

/**
 * A label that shows work is moving: muted ink with a brighter band travelling
 * across it, while `active`. Inactive, it is the plain text in the inherited
 * colour.
 *
 * The band is a full-ink copy of the text seen through a narrow window; both
 * move by transform alone (`animate-shimmer-window` / `animate-shimmer-copy`
 * in `globals.css`, which says why), so the compositor runs it with no
 * repaint and nothing else may animate its opacity. The copy is generated
 * content (`attr(data-text)`) inside an `aria-hidden` window: the text is in
 * the DOM, and read, once. Font size and weight come from
 * `className` or the parent, so both copies are set alike.
 */
export const ShimmerText: FC<{ children: string; active?: boolean; className?: string }> = ({
  children,
  active = true,
  className,
}) => (
  <span className={cn('relative inline-block max-w-full align-top', className)}>
    <span className={cn('block truncate', active && 'text-muted-foreground motion-reduce:text-inherit')}>
      {children}
    </span>
    {active && (
      <span
        aria-hidden="true"
        className="animate-shimmer-window pointer-events-none absolute inset-y-0 left-0 w-1/2 overflow-hidden motion-reduce:hidden"
      >
        <span
          data-text={children}
          className="animate-shimmer-copy text-foreground block w-[200%] truncate before:content-[attr(data-text)]"
        />
      </span>
    )}
  </span>
)
