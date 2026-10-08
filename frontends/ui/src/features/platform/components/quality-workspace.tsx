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
 * - **One window** for the views that have one, in the header beside the title,
 *   so every figure on screen describes the same days.
 * - **The URL is the state.** `?view=` and `?days=` round-trip, so a view a
 *   colleague should look at is a link, and Back walks the tabs you visited.
 */

import type { JSX } from 'react'
import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Gauge, ShieldCheck, ThumbsUp } from 'lucide-react'

import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import { AgentProfiler } from './agent-profiler'
import { AnswerFeedbackHealth } from './answer-feedback-health'
import { CitationHealth } from './citation-health'

export const QUALITY_VIEWS = ['ratings', 'citations', 'timing'] as const
export type QualityView = (typeof QUALITY_VIEWS)[number]

export const QUALITY_WINDOWS = [7, 30, 90] as const
const DEFAULT_WINDOW = 30

/** Read a `?view=` value, falling back to the ratings view for anything else. */
export function parseQualityView(value: string | null | undefined): QualityView {
  return (QUALITY_VIEWS as readonly string[]).includes(value ?? '')
    ? (value as QualityView)
    : 'ratings'
}

/** Read a `?days=` value, falling back to 30 for anything not offered. */
export function parseQualityWindow(value: string | null | undefined): number {
  const days = Number(value)
  return (QUALITY_WINDOWS as readonly number[]).includes(days) ? days : DEFAULT_WINDOW
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

  const view = parseQualityView(searchParams.get('view'))
  const days = parseQualityWindow(searchParams.get('days'))

  const update = useCallback(
    (patch: Partial<{ view: QualityView; days: number }>) => {
      const params = new URLSearchParams(searchParams.toString())
      if (patch.view) params.set('view', patch.view)
      if (patch.days) params.set('days', String(patch.days))
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  // The profiler is a per-conversation timeline, not a window aggregate; a
  // window switch beside it would be a control that does nothing.
  const windowControl =
    view === 'timing' ? null : (
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={String(days)}
        onValueChange={(value) => {
          if (value) update({ days: Number(value) })
        }}
        aria-label={t('qualityWorkspace.windowLabel')}
        data-testid="quality-window"
      >
        {QUALITY_WINDOWS.map((option) => (
          <ToggleGroupItem key={option} value={String(option)} className="px-3 tabular-nums">
            {t('qualityWorkspace.windowDays', { count: option })}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('sections.quality.title')}
        subtitle={t('sections.quality.subtitle')}
        action={windowControl}
      />
      <Tabs
        value={view}
        onValueChange={(next) => update({ view: parseQualityView(next) })}
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
          <AnswerFeedbackHealth days={days} />
        </TabsContent>
        <TabsContent value="citations">
          <CitationHealth days={days} />
        </TabsContent>
        <TabsContent value="timing">
          <AgentProfiler />
        </TabsContent>
      </Tabs>
    </div>
  )
}
