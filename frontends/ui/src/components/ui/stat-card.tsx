import * as React from 'react'

import { cn } from '@/lib/utils'

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
}

export function StatCard({ label, value, hint, className, ...props }: StatCardProps): JSX.Element {
  return (
    <div className={cn('rounded-lg border bg-card p-5', className)} {...props}>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-1 text-sm text-muted-foreground">{label}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}
