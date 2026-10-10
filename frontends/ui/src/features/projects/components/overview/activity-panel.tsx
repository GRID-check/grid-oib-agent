'use client'

import type { JSX } from 'react'
import { MessagesSquare } from 'lucide-react'
import { SpendTrendChart } from '@/components/charts/spend-trend-chart'
import { SectionLabel } from '@/components/ui/section-label'
import { StatCardIcon } from '@/components/ui/stat-card'
import { useLocale, useTranslations } from '@/i18n'

/** `ProjectActivity` from `lib/projects/activity`, as it crosses to the browser. */
export interface ProjectActivityView {
  questionsThisMonth: number
  peopleThisMonth: number
  daily: Array<{ day: string; questions: number }>
}

/**
 * How much the project is being worked in: questions this month, how many
 * people asked, and the last 30 days as columns. Shown to everyone in the
 * hero, because it is counts and nothing else (`getProjectActivity`).
 */
export function ActivityPanel({ activity }: { activity: ProjectActivityView }): JSX.Element {
  const t = useTranslations('settings')
  const { locale } = useLocale()
  const questions = (count: number): string => t('project.overview.activity.questions', { count })

  return (
    <section
      aria-label={t('project.overview.activity.label')}
      className="bg-muted/50 flex flex-col gap-4 rounded-lg p-4 md:p-5"
      data-testid="overview-activity"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex items-center gap-2.5">
          <StatCardIcon icon={MessagesSquare} tone="info" size="sm" />
          <SectionLabel as="h3">{t('project.overview.activity.label')}</SectionLabel>
        </div>
        <dl className="flex gap-6">
          <div>
            <dt className="text-muted-foreground text-xs">
              {t('project.overview.activity.thisMonth')}
            </dt>
            <dd className="text-xl font-semibold tabular-nums tracking-tight">
              {activity.questionsThisMonth.toLocaleString(locale)}
              <span className="text-muted-foreground ml-1.5 text-sm font-normal">
                {t('project.overview.activity.questionsWord', {
                  count: activity.questionsThisMonth,
                })}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">
              {t('project.overview.activity.peopleLabel')}
            </dt>
            <dd className="text-xl font-semibold tabular-nums tracking-tight">
              {activity.peopleThisMonth.toLocaleString(locale)}
            </dd>
          </div>
        </dl>
      </div>
      <SpendTrendChart
        points={activity.daily.map((point) => ({
          day: point.day,
          value: point.questions,
          events: point.questions,
        }))}
        formatValue={questions}
        emptyLabel={t('project.overview.activity.empty')}
      />
    </section>
  )
}
