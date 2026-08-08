'use client'

/**
 * The building over time.
 *
 * A submission is not a file, it is a sequence: the version the Behörde has, the
 * version answering their Verbesserungsauftrag, the version as built. The
 * question that decides a resubmission — "what did we change since the version
 * they already reviewed" — needs that sequence to exist as an object, and
 * everywhere else in the product it does not: Files shows four `.ifc` rows
 * sorted by date and calls it a day.
 *
 * The timeline reads the revision series out of the file names and shows each
 * step's summary deltas — elements, rooms, floor area, model quality. Those are
 * free (they are already in each model's stored summary) so the whole timeline
 * costs no queries, and they are enough to answer "did anything move" before
 * paying for the per-element diff, which the same row starts on demand.
 *
 * A delta shown here is a delta between two exports, not between two buildings:
 * an office that re-exports with a different mapping can move 300 elements
 * without touching the design. That is exactly why the element-level compare is
 * one click away rather than replaced by these numbers.
 */

import { GitBranch, GitCompare } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import type { BimModelHeaderView } from '../hooks/use-bim-model'
import type { BimRevision, BimRevisionDelta, BimRevisionSeries } from '../lib/revisions'

export interface IfcRevisionTimelineProps {
  series: BimRevisionSeries | null
  currentModelId: string | null
  /** Open a revision — the page switches the whole view to it. */
  onOpen: (model: BimModelHeaderView) => void
  /**
   * Diff this revision against its predecessor. The page has to switch to the
   * newer model first, because a comparison is always run FROM the model on
   * screen — which is also what makes the result honest: you are looking at the
   * thing you are diffing.
   */
  onCompareWithPrevious: (revision: BimRevision, previous: BimModelHeaderView) => void
}

/** Signed, with the sign — `+12`, `−3`, and `±0` for "measured, unchanged". */
function useSigned(): (value: number | null) => string {
  const { locale } = useLocale()
  const format = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  })
  return (value) => (value === null ? '—' : value === 0 ? '±0' : format.format(value))
}

function DeltaRow({ delta }: { delta: BimRevisionDelta }): JSX.Element {
  const t = useTranslations('bim')
  const signed = useSigned()
  const entries: Array<{ key: string; value: number | null }> = [
    { key: 'elements', value: delta.elements },
    { key: 'spaces', value: delta.spaces },
    { key: 'storeys', value: delta.storeys },
    { key: 'netFloorArea', value: delta.netFloorArea },
    { key: 'health', value: delta.healthScore },
  ]
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {entries.map((entry) => (
        <li key={entry.key} className="flex items-center gap-1">
          <span>{t(`timeline.delta.${entry.key}`)}</span>
          <span
            className={`tabular-nums ${
              entry.value === null || entry.value === 0
                ? ''
                : entry.value > 0
                  ? 'text-success'
                  : 'text-destructive'
            }`}
          >
            {signed(entry.value)}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function IfcRevisionTimeline({
  series,
  currentModelId,
  onOpen,
  onCompareWithPrevious,
}: IfcRevisionTimelineProps): JSX.Element | null {
  const t = useTranslations('bim')
  const { locale } = useLocale()

  // One revision is not a timeline — the compare panel below already covers
  // "this model against some other file", and a single dot would just be noise.
  if (!series || series.revisions.length < 2) return null

  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })

  return (
    <section aria-labelledby="bim-timeline-heading" className="space-y-2">
      <h2 id="bim-timeline-heading" className="flex items-center gap-2 text-sm font-semibold">
        <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
        {t('timeline.title')}
      </h2>
      <p className="text-xs text-muted-foreground">
        {t('timeline.description', { count: series.revisions.length, name: series.label })}
      </p>

      <ol className="relative space-y-3 border-l pl-4">
        {/* Newest first: the revision being worked on is the one you look at. */}
        {[...series.revisions].reverse().map((revision) => {
          const previous = series.revisions[revision.index - 2]?.model ?? null
          const isCurrent = revision.model.id === currentModelId
          return (
            <li key={revision.model.id} className="relative">
              <span
                aria-hidden="true"
                className={`absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-background ${
                  isCurrent ? 'bg-brand' : 'bg-muted-foreground/40'
                }`}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpen(revision.model)}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`truncate text-sm ${
                    isCurrent ? 'font-semibold' : 'hover:underline'
                  }`}
                >
                  {t('timeline.revision', { index: revision.index })} · {revision.model.filename}
                </button>
                {revision.isLatest && <Badge variant="info">{t('timeline.latest')}</Badge>}
                {revision.model.status !== 'ready' && (
                  <Badge variant="secondary">{t(`status.${revision.model.status}`)}</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {date.format(new Date(revision.model.updatedAt))}
              </p>

              {revision.delta ? (
                <div className="mt-1 space-y-1">
                  <DeltaRow delta={revision.delta} />
                  {previous && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => onCompareWithPrevious(revision, previous)}
                    >
                      <GitCompare className="size-3.5" aria-hidden="true" />
                      {t('timeline.compare', { previous: previous.filename })}
                    </Button>
                  )}
                </div>
              ) : (
                revision.index > 1 && (
                  // No summary on one side — a failed or still-extracting
                  // revision. Saying so beats printing zeros that would read as
                  // "nothing changed".
                  <p className="mt-1 text-xs text-muted-foreground">{t('timeline.noDelta')}</p>
                )
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
