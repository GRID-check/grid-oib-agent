'use client'

import type { JSX } from 'react'
import { AlertTriangle, Gauge } from 'lucide-react'
import { BentoFigure, BentoTile } from '@/components/ui/bento'
import { SpendTrendChart } from '@/components/charts/spend-trend-chart'
import { BudgetMeter } from '@/features/budgets/components/budget-meter'
import { useLocale, useTranslations } from '@/i18n'
import { formatCredits, formatTokens } from '@/lib/format'
import type { ProjectUsageView } from '../settings/usage-settings'

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
 * 30-day trend. Three questions, three forms (the org budget card's rule): a
 * headline number, a ratio against a limit, change over time.
 */
export function UsageTile({ usage, href }: { usage: ProjectUsageView; href: string }): JSX.Element {
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
      span="half"
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
      <SpendTrendChart
        points={usage.dailyTrend.map((point) => ({
          day: point.day,
          value: point.amount,
          events: point.events,
        }))}
        formatValue={withUnit}
        requestsLabel={(count) => t('project.usage.requests', { count })}
        emptyLabel={t('project.overview.usage.trendEmpty')}
      />
    </BentoTile>
  )
}
