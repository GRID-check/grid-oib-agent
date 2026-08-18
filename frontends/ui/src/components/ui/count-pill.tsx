import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * CountPill — the small, soft rounded-full micro-badge that carries a count or
 * ratio ("5 Dokumente", "3/8 erfasst", "7" unread). It is a static,
 * non-interactive label; the shape lives here once so the surfaces that need it
 * cannot drift apart on padding.
 *
 * ## Which tone
 *
 * - **`muted` (default)** — a quiet numeric companion to a heading or a tab
 *   label. The number is context for something the reader is already looking at,
 *   so it must not compete with it. This is almost always the right answer.
 * - **`attention`** — the near-black action ink, for a count that is itself the
 *   signal: something is waiting for the reader and the pill is what tells them
 *   (the inbox "needs you" badge). Use it only where the number is a call to
 *   act, never merely because a count feels important. Ink rather than colour by
 *   design — the design language reserves chroma for provenance signals — and it
 *   keeps the pill legible on the collapsed rail's sunken surface.
 *
 * Distinct from {@link import('./chip').Chip}, which is the interactive,
 * variant-driven pill for clickable affordances (filters, tool tags, sources).
 * When you need hover/focus/click behaviour or a semantic colour, reach for
 * `Chip`; when you just need a number in a pill, reach for this.
 *
 * The project brief, the surfaced-document grid card and the inbox badge all
 * hand-rolled this identical span (and had already drifted on padding); it lives
 * here once.
 */
const countPillVariants = cva(
  'inline-flex min-w-5 shrink-0 items-center justify-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] leading-none tabular-nums',
  {
    variants: {
      tone: {
        muted: 'bg-muted font-medium text-muted-foreground',
        attention: 'bg-primary font-semibold text-primary-foreground',
      },
    },
    defaultVariants: {
      tone: 'muted',
    },
  }
)

export interface CountPillProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof countPillVariants> {}

const CountPill = React.forwardRef<HTMLSpanElement, CountPillProps>(
  ({ className, tone, ...props }, ref) => (
    <span
      ref={ref}
      data-slot="count-pill"
      className={cn(countPillVariants({ tone }), className)}
      {...props}
    />
  )
)
CountPill.displayName = 'CountPill'

export { CountPill, countPillVariants }
