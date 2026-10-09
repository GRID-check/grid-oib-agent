import type { JSX } from 'react'
import * as React from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

export type StatCardIconTone =
  | 'muted'
  | 'success'
  | 'warning'
  | 'info'
  | 'destructive'
  | 'office'
  | 'project'
export type StatCardIconSize = 'md' | 'sm'

/**
 * Tint pairs for {@link StatCardIcon}. The five feedback tones reuse the
 * `chip.tsx` tint pairs verbatim; `office` and `project` are the Büroarchiv
 * and project-document provenance tints, for surfaces whose meaning is that
 * source (the Archiv entry card, a project's documents), not feedback.
 */
const STAT_CARD_ICON_TONES: Record<StatCardIconTone, string> = {
  muted: 'bg-muted text-muted-foreground',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  info: 'bg-info-subtle text-info',
  destructive: 'bg-danger-subtle text-error',
  office: 'bg-source-office-tint text-source-office-text',
  project: 'bg-source-project-tint text-source-project-text',
}

/**
 * The stat-well icon: a tinted rounded well (`size-9` at `md`, `size-7` at
 * `sm`) with the glyph two steps below it. One component so stat wells,
 * entry-card wells and dialog-adjacent wells stop re-deriving the same
 * chip tints inline.
 */
export function StatCardIcon({
  icon: Icon,
  tone = 'muted',
  size = 'md',
  className,
}: {
  icon: LucideIcon
  tone?: StatCardIconTone
  size?: StatCardIconSize
  className?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        size === 'md' ? 'size-9' : 'size-7',
        STAT_CARD_ICON_TONES[tone],
        className
      )}
      aria-hidden="true"
    >
      <Icon className={size === 'md' ? 'size-4' : 'size-3.5'} aria-hidden />
    </div>
  )
}

/**
 * StatCard — the documented numeric stat tile (`grid-design-language.md`
 * §"Component patterns": Stat). One primitive so the ~11 hand-rolled stat sites
 * render the number consistently in `text-2xl … tabular-nums` instead of
 * drifting on `tabular-nums` and padding.
 *
 * Reading order is label, figure, hint: the label row (with the optional icon
 * well) on top, the number below it. The icon used to sit BESIDE a three-line
 * value/label/hint stack, vertically centred, so in a five-up row it floated
 * mid-tile and took the width the label then wrapped into one word per line.
 * On top it costs one line and no width, and every tile in a row puts its
 * figure on the same baseline.
 *
 * The tile is `h-full` so a grid row of tiles is one height whatever each hint
 * says, and {@link StatCardSkeleton} is the same box, so loading and loaded
 * share one height without each surface reserving a `min-h-[…]` literal.
 *
 * @example
 * <StatCard label="Projekte" value={12} hint="+2 diese Woche" />
 */
export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode
  value: React.ReactNode
  /** Optional supporting line rendered under the figure. */
  hint?: React.ReactNode
  /** Optional leading icon (a lucide glyph), drawn in a small well beside the label. */
  icon?: React.ReactNode
}

const STAT_CARD_CLASS = 'flex h-full min-h-28 flex-col rounded-lg border bg-card p-5 shadow-xs'

export function StatCard({
  label,
  value,
  hint,
  icon,
  className,
  ...props
}: StatCardProps): JSX.Element {
  return (
    <div className={cn(STAT_CARD_CLASS, className)} {...props}>
      <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm">
        {icon ? (
          <span
            className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5"
            aria-hidden
          >
            {icon}
          </span>
        ) : null}
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="text-muted-foreground mt-1 text-pretty text-xs">{hint}</div>}
    </div>
  )
}

/** The loading stand-in for one {@link StatCard}: the same box, shimmering. */
export function StatCardSkeleton({ className }: { className?: string }): JSX.Element {
  return (
    <div className={cn(STAT_CARD_CLASS, className)} aria-hidden>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-6 w-16" />
      <Skeleton className="mt-2 h-3 w-32" />
    </div>
  )
}
