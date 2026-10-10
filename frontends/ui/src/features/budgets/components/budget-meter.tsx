'use client'

/**
 * The budget meter, shared by the organization's Usage & budgets card and a
 * project's usage section, so "how close is this to being stopped" reads the
 * same in both. The rationale for its form (a meter, not a chart; fill colour
 * carries severity, never identity) is in `organization/budget-usage-card.tsx`.
 *
 * Its colours are the `--spend-meter*` tokens, scoped by the `grid-spend-viz`
 * class: a caller wraps it in an element carrying that class.
 */

import type { FC } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useTranslations } from '@/i18n'

/**
 * Spend against one limit. The track IS the limit, so "how full" is literal
 * rather than a rescaled proportion; once spend passes the limit the track has
 * to grow to hold it, and a tick marks where the limit sat. The tick only ever
 * appears in the over state, where the sentence underneath explains it — an
 * unlabelled reference line is furniture the reader has to guess at.
 */
export const BudgetMeter: FC<{
  title: string
  total: number
  limit: number | null
  /** Number plus unit word, in the organization's unit. */
  formatAmount: (value: number) => string
}> = ({ title, total, limit, formatAmount }) => {
  const t = useTranslations('organization')
  const over = limit !== null && total >= limit
  const scale = limit !== null ? Math.max(limit, total) : total
  const fillPct = scale > 0 ? Math.min((total / scale) * 100, 100) : 0
  const limitPct = over && limit !== null && scale > 0 ? (limit / scale) * 100 : null
  const reading =
    limit !== null
      ? t('budgets.ofLimit', { spent: formatAmount(total), limit: formatAmount(limit) })
      : t('budgets.noLimit', { spent: formatAmount(total) })

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        {/* The direct label. Every meter states its own value, so the fill
            colour is a redundant cue and never the only carrier of state. */}
        <p className="text-muted-foreground text-right text-xs tabular-nums">{reading}</p>
      </div>
      <div
        className="bg-muted relative mt-1.5 h-2.5 w-full overflow-hidden rounded-[4px]"
        role="img"
        aria-label={`${title}: ${reading}`}
        data-testid={`budget-meter-${over ? 'over' : 'within'}`}
      >
        <div
          className="h-full rounded-r-[4px]"
          style={{
            width: `${fillPct}%`,
            backgroundColor: over ? 'var(--spend-meter-over)' : 'var(--spend-meter)',
          }}
        />
        {limitPct !== null && (
          <span
            className="bg-foreground/60 absolute inset-y-0 w-px"
            style={{ left: `${limitPct}%` }}
            aria-hidden
            data-testid="budget-limit-tick"
          />
        )}
      </div>
      {over && (
        <p className="text-destructive mt-1 flex items-center gap-1 text-xs">
          <AlertTriangle className="size-3" aria-hidden />
          {t('budgets.overLimit')}
        </p>
      )}
    </div>
  )
}
