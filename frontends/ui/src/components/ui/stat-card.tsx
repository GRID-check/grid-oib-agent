import * as React from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export type StatCardIconTone = 'muted' | 'success' | 'warning' | 'info' | 'destructive' | 'office'
export type StatCardIconSize = 'md' | 'sm'

/**
 * Tint pairs for {@link StatCardIcon}. The five feedback tones reuse the
 * `chip.tsx` tint pairs verbatim; `office` is the Büroarchiv provenance tint
 * for surfaces (like the Archiv entry card) whose meaning is office, not
 * feedback.
 */
const STAT_CARD_ICON_TONES: Record<StatCardIconTone, string> = {
  muted: 'bg-muted text-muted-foreground',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  info: 'bg-info-subtle text-info',
  destructive: 'bg-danger-subtle text-error',
  office: 'bg-source-office-tint text-source-office-text',
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
 * render the number consistently in `text-2xl … tabular-nums` with a muted
 * label below, instead of drifting on `tabular-nums` and padding.
 *
 * @example
 * <StatCard label="Projekte" value={12} hint="+2 diese Woche" />
 */
export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode
  value: React.ReactNode
  /** Optional supporting line rendered under the label. */
  hint?: React.ReactNode
  /** Optional leading icon disc. */
  icon?: React.ReactNode
}

export function StatCard({ label, value, hint, icon, className, ...props }: StatCardProps): JSX.Element {
  return (
    <div className={cn('rounded-lg border bg-card p-5 shadow-xs', className)} {...props}>
      <div className={cn(icon && 'flex items-center gap-3')}>
        {icon ? (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0">
          <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
          <div className="mt-1 text-sm text-muted-foreground">{label}</div>
          {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
        </div>
      </div>
    </div>
  )
}
