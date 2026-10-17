'use client'

import { memo, useState, type JSX } from 'react'
import { useMediaQuery } from '@/hooks/use-media-query'
import { CheckCheck, ChevronDown, Clock, MessageCircle, MousePointerClick, Sparkles, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CommentPin } from '@/components/ui/comment-pin'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import { formatDayRange, localCalendarDay } from '@/lib/format'
import { isLive, isOverdue, type AnnotationView } from '@/lib/annotations/types'
import { cn } from '@/lib/utils'
import type { DocumentReview, ReviewFilter } from '../../hooks/use-document-review'
import { usePilotiByline } from './piloti-attribution'
import { markInk } from './review-page-layer'

/** Open a mark from the list; `byKeyboard` when Enter or Space did it, so its card takes the focus. */
export type OpenMark = (annotation: AnnotationView, byKeyboard?: boolean) => void

/**
 * One mark in the list: its number (what people say aloud), what it says, and
 * one quiet line of who, how many answers, and by when. Memoised on its mark:
 * a list of five hundred redraws the row that changed.
 */
const Row = memo(function Row({
  annotation,
  selected,
  onHover,
  onOpen,
}: {
  annotation: AnnotationView
  selected: boolean
  onHover: (annotationId: string | null) => void
  onOpen: OpenMark
}): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const byline = usePilotiByline()
  const overdue = isOverdue(annotation, localCalendarDay())
  const author =
    annotation.authorKind === 'piloti' ? byline(annotation.createdByName) : (annotation.createdByName ?? t('review.someone'))
  return (
    <li>
      <button
        type="button"
        data-testid="review-row"
        aria-current={selected || undefined}
        // `detail` is 0 for a click the keyboard made.
        onClick={(event) => onOpen(annotation, event.detail === 0)}
        onPointerEnter={() => onHover(annotation.id)}
        onPointerLeave={() => onHover(null)}
        className={cn(
          'flex w-full gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-quick ease-out outline-none',
          'hover:bg-accent/60 focus-visible:ring-ring/60 focus-visible:ring-2',
          selected && 'bg-accent'
        )}
      >
        <span className="pt-0.5">
          <CommentPin
            as="span"
            number={annotation.number}
            color={markInk(annotation)}
            proposed={annotation.status === 'proposed'}
            done={!isLive(annotation)}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('text-foreground line-clamp-2 text-sm leading-5', !isLive(annotation) && 'text-muted-foreground')}>
            {annotation.body}
          </span>
          {/* Items separated by space and their own icons, never a leading „·"
              when a line wraps; each item keeps to one line. */}
          <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs" data-testid="review-row-meta">
            <span className="whitespace-nowrap">{t(`annotations.kinds.${annotation.kind}`)}</span>
            <span className="min-w-0 truncate">{author}</span>
            {annotation.assigneeName && (
              <span className="inline-flex min-w-0 items-center gap-0.5 whitespace-nowrap">
                <UserRound className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{annotation.assigneeName}</span>
              </span>
            )}
            {annotation.replies.length > 0 && (
              <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                <MessageCircle className="size-3" aria-hidden />
                {annotation.replies.length}
              </span>
            )}
            {annotation.dueOn && (
              <span className={cn('inline-flex items-center gap-0.5 whitespace-nowrap', overdue && 'text-foreground font-semibold')}>
                <Clock className="size-3" aria-hidden />
                {overdue ? t('review.overdue') : formatDayRange(annotation.dueOn, annotation.dueOn, locale)}
              </span>
            )}
          </span>
          {!annotation.onCurrentFassung && (
            <span className="text-muted-foreground mt-0.5 block text-xs italic" title={t('annotations.earlierFassungHint')}>
              {annotation.fassungNumber
                ? t('annotations.earlierFassung', { number: annotation.fassungNumber })
                : t('annotations.earlierFassungUnnumbered')}
            </span>
          )}
        </span>
      </button>
    </li>
  )
})

/** Marks grouped by page; the page heading only where there is more than one page to tell apart. */
function Pages({
  marks,
  review,
  onOpen,
}: {
  marks: readonly AnnotationView[]
  review: DocumentReview
  onOpen: OpenMark
}): JSX.Element {
  const t = useTranslations('files')
  const pages = [...new Set(marks.map((annotation) => annotation.page))]
  const headed = new Set(review.annotations.map((annotation) => annotation.page)).size > 1
  return (
    <>
      {pages.map((page) => (
        <section key={page} aria-label={t('review.page', { page })}>
          {headed && (
            <h3 className="text-muted-foreground px-2.5 pt-3 pb-1 text-[11px] font-semibold tracking-[0.05em] uppercase">
              {t('review.page', { page })}
            </h3>
          )}
          <ul className="space-y-0.5">
            {marks
              .filter((annotation) => annotation.page === page)
              .map((annotation) => (
                <Row
                  key={annotation.id}
                  annotation={annotation}
                  selected={annotation.id === review.selectedId}
                  onHover={review.hover}
                  onOpen={onOpen}
                />
              ))}
          </ul>
        </section>
      ))}
    </>
  )
}

const FILTERS: ReviewFilter[] = ['open', 'closed']

/**
 * The counts on the Offen / Erledigt tabs, over what the list would show:
 * with „Mir zugewiesen" on, only the marks assigned to or set by the reader,
 * the same marks the list holds, so a tab never promises six and shows two.
 */
export function tabCounts(
  annotations: readonly Pick<AnnotationView, 'status' | 'assigneeUserId' | 'createdBy'>[],
  mine: { on: boolean; me: string | null }
): Record<ReviewFilter, number> {
  const shown = mine.on
    ? annotations.filter(
        (annotation) => mine.me !== null && (annotation.assigneeUserId === mine.me || annotation.createdBy === mine.me)
      )
    : annotations
  return {
    open: shown.filter((annotation) => isLive(annotation)).length,
    closed: shown.filter((annotation) => !isLive(annotation)).length,
  }
}

/**
 * The review's list: every mark of the document, in the order a review walks
 * them. Piloti's proposals are not a tab of their own, which would hide them
 * from the work: they lead the open list as a group with one way through them.
 * Selecting a row brings its mark to the middle of the view and opens its
 * thread; hovering a row lights its mark on the page.
 */
export function ReviewPanel({
  review,
  onOpen,
  onWalkProposals,
  presentation = 'rail',
}: {
  review: DocumentReview
  onOpen: OpenMark
  /** Start going through Piloti's proposals one by one. */
  onWalkProposals?: () => void
  /**
   * `rail`: the column beside the sheet, from `lg`. `sheet`: the same list in
   * a sheet from the bottom edge, which is how a phone (and a phone on its
   * side, at 852px still under `lg`) walks the marks; without it the only way
   * to an item there was to find its pin on the drawing.
   */
  presentation?: 'rail' | 'sheet'
}): JSX.Element {
  const t = useTranslations('files')
  const { listed, filter, setFilter, load, mine, setMine } = review
  const counts = tabCounts(review.annotations, { on: mine, me: review.room.self?.userId ?? null })
  const [proposalsOpen, setProposalsOpen] = useState(true)
  const proposals = filter === 'open' ? listed.filter((annotation) => annotation.status === 'proposed') : []
  const rest = listed.filter((annotation) => !proposals.includes(annotation))

  return (
    <aside
      data-testid="review-panel"
      aria-label={t('annotations.section')}
      className={cn(
        'bg-background flex flex-col',
        presentation === 'rail' ? 'h-full w-[22rem] shrink-0 border-l max-lg:hidden' : 'min-h-0 flex-1',
      )}
    >
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        {/* Two buttons that say which is on, not a tab list: there is no tab panel, and Tab reaches each. */}
        <div role="group" aria-label={t('review.filter')} className="bg-muted inline-flex rounded-lg p-0.5">
          {FILTERS.map((option) => {
            const count = counts[option]
            return (
              <button
                key={option}
                type="button"
                aria-pressed={filter === option}
                data-testid={`review-filter-${option}`}
                onClick={() => setFilter(option)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors duration-quick ease-out pointer-coarse:h-10',
                  filter === option ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t(`review.filters.${option}`)}
                <span className="text-muted-foreground font-mono tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
        <button
          type="button"
          aria-pressed={mine}
          data-testid="review-filter-mine"
          onClick={() => setMine(!mine)}
          className={cn(
            'ml-auto inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium transition-colors duration-quick ease-out pointer-coarse:h-11 pointer-coarse:px-3.5',
            mine ? 'bg-foreground text-background border-transparent' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {t('review.mine')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {load === 'loading' ? (
          <div className="flex justify-center py-10">
            <Spinner size="sm" />
          </div>
        ) : load === 'error' ? (
          <div className="space-y-2 px-2 py-6 text-center">
            <p className="text-muted-foreground text-sm">{t('annotations.loadError')}</p>
            <Button type="button" variant="outline" size="sm" onClick={review.retry}>
              {t('annotations.retry')}
            </Button>
          </div>
        ) : listed.length === 0 ? (
          <EmptyList review={review} />
        ) : (
          <>
            {proposals.length > 0 && (
              <section
                data-testid="review-proposals"
                className="border-foreground/25 mx-0.5 mb-2 rounded-xl border border-dashed"
              >
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <button
                    type="button"
                    aria-expanded={proposalsOpen}
                    onClick={() => setProposalsOpen((open) => !open)}
                    className="text-foreground flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-semibold"
                  >
                    <Sparkles className="size-3.5" aria-hidden />
                    {t('review.proposalsGroup', { count: proposals.length })}
                    <ChevronDown
                      className={cn('text-muted-foreground size-3.5 transition-transform duration-quick', !proposalsOpen && '-rotate-90')}
                      aria-hidden
                    />
                  </button>
                  {onWalkProposals && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      data-testid="review-walk-proposals"
                      onClick={onWalkProposals}
                    >
                      {t('review.walkProposals')}
                    </Button>
                  )}
                </div>
                {proposalsOpen && (
                  <div className="px-0.5 pb-1">
                    <Pages marks={proposals} review={review} onOpen={onOpen} />
                    <p className="text-muted-foreground px-2.5 pt-1 pb-1.5 text-[11px] leading-4" data-testid="review-proposals-legend">
                      {t('review.proposalsLegend')}
                    </p>
                  </div>
                )}
              </section>
            )}
            <Pages marks={rest} review={review} onOpen={onOpen} />
          </>
        )}
      </div>
    </aside>
  )
}

/** What an empty list says depends on why it is empty: nothing yet, nothing left, or nothing in this view. */
function EmptyList({ review }: { review: DocumentReview }): JSX.Element {
  const t = useTranslations('files')
  const { counts, filter, annotations, mine } = review
  // A finger has no C or R: the touch copy names the button instead.
  const touch = useMediaQuery('(pointer: coarse)')
  const allDone = filter === 'open' && !mine && annotations.length > 0 && counts.open + counts.proposed === 0
  const Icon = allDone ? CheckCheck : MousePointerClick
  const key = mine
    ? 'mine'
    : allDone
      ? 'done'
      : annotations.length === 0
        ? review.canAnnotate
          ? 'none'
          : 'readOnly'
        : filter
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center" data-testid="review-empty">
      <span className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="text-foreground mt-3 text-sm font-medium">{t(`review.empty.${key}Title`)}</p>
      <p className="text-muted-foreground mt-1 text-xs leading-5">
        {key === 'none' && touch ? t('review.empty.noneBodyTouch') : t(`review.empty.${key}Body`)}
      </p>
    </div>
  )
}
