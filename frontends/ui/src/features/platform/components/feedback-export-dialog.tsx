'use client'

/**
 * „Exportieren…" on the ratings tab: the votes the page shows, as a file.
 *
 * The dialog does not choose what to export; the page already did. It says what
 * the file will hold in the page's own words (range, organizations, projects,
 * every rating filter), how many votes that is, and offers the two choices that
 * are about the FILE: the format, and "every rating in the range" without the
 * rating filters, which is the export people mean when they ask for "the
 * feedback" while looking at a filtered list.
 *
 * - **Live count.** From `/api/platform/answer-feedback/options`, the same
 *   strict parser and the same SQL as the export, debounced (300 ms), with a
 *   stale guard so a slow answer for the previous choice never overwrites the
 *   current one. Zero disables the download; over the cap says which votes go.
 * - **The download is a link.** `<a download href>` to the export route, built
 *   from the same query string; the route sets `Content-Disposition`, so the
 *   file costs the bundle nothing and the dialog fetches nothing but the count.
 * - **Phone.** Full height (`fullScreenOnMobile`), sections stacked.
 */

import type { JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Download, FileSpreadsheet, FileText } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Chip } from '@/components/ui/chip'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useLocale, useTranslations } from '@/i18n'
import { formatDayRange } from '@/lib/format'
import {
  feedbackQueryString,
  NO_RATINGS_FILTERS,
  ratingsFiltered,
  type FeedbackQuery,
} from '@/lib/feedback/filters'
import type { FeedbackFilterOptions } from '@/lib/feedback/export-service'
import { formatCount } from './answer-feedback-types'
import { useRatingsFilterLabels } from './feedback-filter-labels'

const EXPORT_ROUTE = '/api/platform/answer-feedback/export'
const OPTIONS_ROUTE = '/api/platform/answer-feedback/options'
const COUNT_DEBOUNCE_MS = 300

export type FeedbackExportFormat = 'xlsx' | 'csv'

/** The query the file is read with: the page's, or its scope alone. */
export function exportQuery(query: FeedbackQuery, allVotes: boolean): FeedbackQuery {
  return allVotes ? { scope: query.scope, ratings: NO_RATINGS_FILTERS } : query
}

/** The download link: the export route with the page's query string and the format. */
export function feedbackExportHref(query: FeedbackQuery, format: FeedbackExportFormat, allVotes = false): string {
  return `${EXPORT_ROUTE}?${feedbackQueryString(exportQuery(query, allVotes))}&format=${format}`
}

export interface FeedbackExportDialogProps {
  query: FeedbackQuery
  /** Display names for the scope's ids; the id is shown when a name is unknown. */
  organizationName: (id: string) => string
  projectName: (id: string) => string
  /** Open on mount (the `/dev` preview). */
  defaultOpen?: boolean
}

type CountState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; options: FeedbackFilterOptions }

export function FeedbackExportDialog({
  query,
  organizationName,
  projectName,
  defaultOpen = false,
}: FeedbackExportDialogProps): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const allVotesId = useId()
  const [open, setOpen] = useState(defaultOpen)
  const [format, setFormat] = useState<FeedbackExportFormat>('xlsx')
  const [allVotes, setAllVotes] = useState(false)
  const [count, setCount] = useState<CountState>({ kind: 'loading' })
  const latestRequest = useRef(0)

  const filtered = ratingsFiltered(query.ratings)
  const effective = exportQuery(query, allVotes && filtered)
  const search = feedbackQueryString(effective)

  useEffect(() => {
    if (!open) return
    const requestId = ++latestRequest.current
    setCount({ kind: 'loading' })
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`${OPTIONS_ROUTE}?${search}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status))
          const options = (await res.json()) as FeedbackFilterOptions
          // Only the newest request may write: a slower answer for the
          // previous choice must not replace the count for the current one.
          if (requestId === latestRequest.current) setCount({ kind: 'ready', options })
        })
        .catch(() => {
          if (requestId === latestRequest.current && !controller.signal.aborted) setCount({ kind: 'failed' })
        })
    }, COUNT_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, search])

  const labels = useRatingsFilterLabels(query.ratings)
  const href = feedbackExportHref(query, format, allVotes && filtered)
  const empty = count.kind === 'ready' && count.options.total === 0
  const n = (value: number): string => formatCount(value, locale)
  const names = (ids: readonly string[], name: (id: string) => string): string =>
    ids.length ? ids.map(name).join(', ') : t('answerFeedback.exportDialog.everything')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="feedback-export">
          <Download className="size-3.5" aria-hidden />
          {t('answerFeedback.exportDialog.trigger')}
        </Button>
      </DialogTrigger>
      <DialogContent fullScreenOnMobile className="sm:max-w-xl" data-testid="feedback-export-dialog">
        <DialogHeader className="text-left">
          <DialogTitle>{t('answerFeedback.exportDialog.title')}</DialogTitle>
          <DialogDescription>{t('answerFeedback.exportDialog.description')}</DialogDescription>
        </DialogHeader>

        <section className="flex flex-col gap-3" aria-labelledby={`${allVotesId}-applied`}>
          <SectionLabel id={`${allVotesId}-applied`}>{t('answerFeedback.exportDialog.appliedHeading')}</SectionLabel>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]" data-testid="feedback-export-summary">
            <dt className="text-muted-foreground">{t('answerFeedback.exportDialog.range')}</dt>
            <dd className="tabular-nums">{formatDayRange(query.scope.from, query.scope.to, locale)}</dd>
            <dt className="text-muted-foreground">{t('answerFeedback.exportDialog.organizations')}</dt>
            <dd className="min-w-0 break-words">{names(query.scope.organizationIds, organizationName)}</dd>
            <dt className="text-muted-foreground">{t('answerFeedback.exportDialog.projects')}</dt>
            <dd className="min-w-0 break-words">{names(query.scope.projectIds, projectName)}</dd>
            <dt className="text-muted-foreground">{t('answerFeedback.exportDialog.ratingsFilters')}</dt>
            <dd className="flex min-w-0 flex-wrap gap-1.5">
              {labels.length && !(allVotes && filtered) ? (
                labels.map((label) => (
                  <Chip key={label} variant="secondary" className="max-w-full whitespace-normal">
                    {label}
                  </Chip>
                ))
              ) : (
                <span>{t('answerFeedback.exportDialog.none')}</span>
              )}
            </dd>
          </dl>
          {filtered ? (
            <Field orientation="horizontal" className="items-start justify-start gap-2.5">
              <Checkbox
                id={allVotesId}
                checked={allVotes}
                onCheckedChange={(checked) => setAllVotes(checked === true)}
                className="mt-0.5"
                data-testid="feedback-export-all-votes"
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={allVotesId} className="font-normal leading-snug">
                  {t('answerFeedback.exportDialog.allVotes')}
                </Label>
                <FieldDescription>{t('answerFeedback.exportDialog.allVotesHint')}</FieldDescription>
              </div>
            </Field>
          ) : null}
        </section>

        <Field>
          <FieldLabel>{t('answerFeedback.exportDialog.format')}</FieldLabel>
          <ToggleGroup
            type="single"
            size="sm"
            segmented
            value={format}
            onValueChange={(value) => {
              if (value === 'xlsx' || value === 'csv') setFormat(value)
            }}
            aria-label={t('answerFeedback.exportDialog.format')}
            data-testid="feedback-export-format"
          >
            <ToggleGroupItem value="xlsx">
              <FileSpreadsheet className="size-3.5" aria-hidden />
              {t('answerFeedback.exportDialog.formatXlsx')}
            </ToggleGroupItem>
            <ToggleGroupItem value="csv">
              <FileText className="size-3.5" aria-hidden />
              {t('answerFeedback.exportDialog.formatCsv')}
            </ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription>
            {format === 'xlsx'
              ? t('answerFeedback.exportDialog.formatXlsxHint')
              : t('answerFeedback.exportDialog.formatCsvHint')}
          </FieldDescription>
        </Field>

        <p
          role="status"
          aria-live="polite"
          className="text-sm font-medium tabular-nums"
          data-testid="feedback-export-count"
          data-state={count.kind === 'ready' ? (empty ? 'empty' : count.options.overCap ? 'over' : 'ready') : count.kind}
        >
          {count.kind === 'loading' ? (
            <span className="text-muted-foreground inline-flex items-center gap-2 font-normal">
              <Spinner size="xs" aria-hidden />
              {t('answerFeedback.exportDialog.counting')}
            </span>
          ) : count.kind === 'failed' ? (
            <span className="text-muted-foreground font-normal">{t('answerFeedback.exportDialog.countFailed')}</span>
          ) : empty ? (
            t('answerFeedback.exportDialog.countNone')
          ) : count.options.overCap ? (
            t('answerFeedback.exportDialog.countOver', { cap: n(count.options.cap) })
          ) : count.options.total === 1 ? (
            t('answerFeedback.exportDialog.countOne')
          ) : (
            t('answerFeedback.exportDialog.count', { count: n(count.options.total) })
          )}
        </p>

        <DialogFooter className="max-sm:mt-auto">
          <DialogClose asChild>
            <Button variant="ghost">{t('answerFeedback.exportDialog.cancel')}</Button>
          </DialogClose>
          {empty ? (
            <Button disabled data-testid="feedback-export-download">
              <Download className="size-4" aria-hidden />
              {t('answerFeedback.exportDialog.download')}
            </Button>
          ) : (
            <Button asChild>
              <a href={href} download data-testid="feedback-export-download">
                <Download className="size-4" aria-hidden />
                {t('answerFeedback.exportDialog.download')}
              </a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
