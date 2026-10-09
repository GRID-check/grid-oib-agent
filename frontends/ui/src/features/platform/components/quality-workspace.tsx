'use client'

/**
 * Platform → Answer quality, as one workspace with three views.
 *
 * The page used to stack three whole dashboards (citation health, answer
 * feedback, agent profiler) in one column, each with its own window switch, so
 * "the last 30 days" could mean three different windows on one screen and the
 * feedback the page is named for started two screen-heights down. Now:
 *
 * - **Ratings first.** What the people who read the answers thought is the
 *   question the page is opened with; it is the default view.
 * - **One scope** for every view: a date range, organizations and projects,
 *   in the bar under the header (`QualityScopeBar`), handed to each view as
 *   `scope`. The ratings view adds filters of its own on top, which only votes
 *   have (verdict, reason, topic …), and its export is exactly what it shows.
 * - **The URL is the state.** `?view=`, the scope (`from`, `to`, `org`,
 *   `project`) and the ratings filters round-trip, so a view a colleague should
 *   look at is a link, and Back walks the changes you made.
 */

import type { JSX } from 'react'
import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Gauge, ShieldCheck, ThumbsUp } from 'lucide-react'

import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslations } from '@/i18n'
import { readRatingsFilters, writeRatingsFilters, type RatingsFilters } from '@/lib/feedback/filters'
import { readQualityScope, writeQualityScope, type QualityScope } from '@/lib/quality/scope'
import { AgentProfiler } from './agent-profiler'
import { AnswerFeedbackHealth } from './answer-feedback-health'
import { CitationHealth } from './citation-health'
import { QualityScopeBar, useQualityScopeOptions } from './quality-scope-bar'

export const QUALITY_VIEWS = ['ratings', 'citations', 'timing'] as const
export type QualityView = (typeof QUALITY_VIEWS)[number]

/** Read a `?view=` value, falling back to the ratings view for anything else. */
export function parseQualityView(value: string | null | undefined): QualityView {
  return (QUALITY_VIEWS as readonly string[]).includes(value ?? '')
    ? (value as QualityView)
    : 'ratings'
}

const VIEW_ICON: Record<QualityView, typeof ThumbsUp> = {
  ratings: ThumbsUp,
  citations: ShieldCheck,
  timing: Gauge,
}

export function QualityWorkspace(): JSX.Element {
  const t = useTranslations('platform')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const current = searchParams.toString()

  const view = parseQualityView(searchParams.get('view'))
  // Memoised on the query string: the readers build a new object per call, and
  // the views fetch when the scope they are handed changes.
  const scope = useMemo(() => readQualityScope(new URLSearchParams(current)), [current])
  const ratings = useMemo(() => readRatingsFilters(new URLSearchParams(current)), [current])
  const scopeOptions = useQualityScopeOptions(scope)

  const push = useCallback(
    (params: URLSearchParams) => router.push(`${pathname}?${params.toString()}`, { scroll: false }),
    [pathname, router]
  )
  const setView = useCallback(
    (next: QualityView) => {
      const params = new URLSearchParams(current)
      params.set('view', next)
      push(params)
    },
    [current, push]
  )
  const setScope = useCallback(
    (next: QualityScope) => push(writeQualityScope(new URLSearchParams(current), next)),
    [current, push]
  )
  const setRatings = useCallback(
    (next: RatingsFilters) => push(writeRatingsFilters(new URLSearchParams(current), next)),
    [current, push]
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <PageHeader title={t('sections.quality.title')} subtitle={t('sections.quality.subtitle')} />
        <QualityScopeBar scope={scope} onScopeChange={setScope} options={scopeOptions} />
      </div>
      <Tabs
        value={view}
        onValueChange={(next) => setView(parseQualityView(next))}
        className="gap-6"
      >
        {/* Full width on a phone so three labels share the row instead of
            scrolling; natural width beside the content from `sm`. */}
        <TabsList className="w-full sm:w-fit" aria-label={t('qualityWorkspace.viewsLabel')}>
          {QUALITY_VIEWS.map((key) => {
            const Icon = VIEW_ICON[key]
            return (
              <TabsTrigger key={key} value={key} data-testid={`quality-tab-${key}`}>
                <Icon aria-hidden />
                {t(`qualityWorkspace.views.${key}`)}
              </TabsTrigger>
            )
          })}
        </TabsList>
        <p className="text-muted-foreground -mt-3 text-sm">
          {t(`qualityWorkspace.descriptions.${view}`)}
        </p>
        {/* Only the open view mounts (Radix unmounts inactive content), so a
            tab nobody opens costs no request. */}
        <TabsContent value="ratings">
          <AnswerFeedbackHealth
            scope={scope}
            filters={ratings}
            onFiltersChange={setRatings}
            onScopeChange={setScope}
            scopeOptions={scopeOptions.options}
          />
        </TabsContent>
        <TabsContent value="citations">
          <CitationHealth scope={scope} />
        </TabsContent>
        <TabsContent value="timing">
          <AgentProfiler scope={scope} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
