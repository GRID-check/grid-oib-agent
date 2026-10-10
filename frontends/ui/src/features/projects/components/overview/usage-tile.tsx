'use client'

import type { JSX } from 'react'
import { AlertTriangle, Gauge } from 'lucide-react'
import { BentoFigure, BentoTile, type BentoSpan } from '@/components/ui/bento'
import { BudgetMeter } from '@/features/budgets/components/budget-meter'
import { useLocale, useTranslations } from '@/i18n'
import { formatCredits, formatTokens } from '@/lib/format'
import type { ProjectUsageView } from '../settings/usage-settings'

/** Models named in the tile; the Usage section lists every one. */
const TOP_MODELS = 3

/** The tighter of the project's and the organization's monthly limit. */
function monthlyCeiling(usage: ProjectUsageView): number | null {
  const project = usage.projectLimit?.monthlyLimit ?? null
  const org = usage.orgLimit.monthlyLimit
  if (project === null) return org
  if (org === null) return project
  return Math.min(project, org)
}

/**
 * Spend this month: the figure, the meter against what would stop it, and the
 * models it went to. No trend here: the hero's activity chart already shows
 * how the month went, and two lookalike column charts side by side read as one
 * thing drawn twice.
 */
export function UsageTile({
  usage,
  href,
  span = 'major',
}: {
  usage: ProjectUsageView
  href: string
  span?: BentoSpan
}): JSX.Element {
  const t = useTranslations('settings')
  const tOrg = useTranslations('organization')
  const { locale } = useLocale()

  const onOwnKey = usage.unit === 'token'
  const bare = (value: number): string =>
    onOwnKey ? formatTokens(value, locale) : formatCredits(value, locale)
  const withUnit = (value: number): string =>
    tOrg(onOwnKey ? 'budgets.tokensValue' : 'budgets.creditsValue', { value: bare(value) })
  const ceiling = monthlyCeiling(usage)

  return (
    <BentoTile
      label={t('project.overview.usage.label')}
      icon={Gauge}
      span={span}
      href={href}
      linkLabel={t('project.overview.usage.open')}
      data-testid="overview-usage"
    >
      <div className="flex items-end justify-between gap-4">
        <BentoFigure
          value={withUnit(usage.month.amount)}
          // With a ceiling the meter below states "x of y"; without one, say so.
          caption={ceiling === null ? t('project.overview.usage.noLimit') : undefined}
        />
      </div>
      {usage.blockedScope && (
        <p className="text-destructive flex items-center gap-1.5 text-xs">
          <AlertTriangle className="size-3.5" aria-hidden />
          {t('project.overview.usage.blocked')}
        </p>
      )}
      {ceiling !== null && (
        <div className="grid-spend-viz">
          <BudgetMeter
            title={t('project.usage.thisMonth')}
            total={usage.month.amount}
            limit={ceiling}
            formatAmount={withUnit}
          />
        </div>
      )}
      {usage.perModel.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-sm">
          {usage.perModel.slice(0, TOP_MODELS).map((entry) => (
            <li key={entry.model} className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                {entry.model}
              </span>
              <span className="shrink-0 tabular-nums">{withUnit(entry.month.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </BentoTile>
  )
}
