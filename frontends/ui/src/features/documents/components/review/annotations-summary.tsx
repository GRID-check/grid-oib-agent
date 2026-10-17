'use client'

import type { JSX } from 'react'
import { MessageSquareText, RotateCcw, ScanEye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CommentPin } from '@/components/ui/comment-pin'
import { CountPill } from '@/components/ui/count-pill'
import { InspectorGroup, InspectorSection } from '@/components/ui/inspector-group'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { isLive } from '@/lib/annotations/types'
import { cn } from '@/lib/utils'
import type { DocumentReview } from '../../hooks/use-document-review'
import { useRoomSelector } from '../../hooks/use-document-room'
import { markInk } from './review-page-layer'

/** Live marks the rail shows before it sends the reader into the review for the rest. */
const PREVIEWED = 3

/**
 * „Anmerkungen" in the opened document's rail: how much is open, the first few
 * marks, and the door into the focused review, which is where marks are set,
 * discussed and closed. The rail only tells; the review is where the work
 * happens, so the rail never grows a form.
 *
 * The section stands while the list loads and when it could not be read, the
 * way the review's own list does: a rail section that appears a second late,
 * or never when the read failed, says nothing about whether the document has
 * marks at all.
 */
export function AnnotationsSummary({
  review,
  onOpenReview,
  className,
}: {
  review: DocumentReview
  /** Open the review, at one mark when given. */
  onOpenReview: (annotationId?: string) => void
  className?: string
}): JSX.Element {
  const t = useTranslations('files')
  const live = review.annotations.filter(isLive)
  const others = useRoomSelector(
    review.room,
    (peers) => new Set(peers.filter((state) => state.peer.kind !== 'piloti').map((state) => state.peer.userId)).size
  )
  const ready = review.load === 'ready'
  return (
    <InspectorSection
      label={t('annotations.section')}
      icon={MessageSquareText}
      action={
        ready && live.length > 0 ? <CountPill>{t('annotations.openCount', { count: live.length })}</CountPill> : undefined
      }
      className={className}
      data-testid="annotations-summary"
    >
      <InspectorGroup>
        {review.load === 'loading' && (
          <div role="status" aria-label={t('annotations.loading')} className="flex items-center gap-2.5 px-3 py-2.5" data-testid="annotations-summary-loading">
            <Skeleton className="size-6 shrink-0 rounded-full" />
            <Skeleton className="h-3 flex-1" />
          </div>
        )}
        {review.load === 'error' && (
          <div className="space-y-2 p-3" data-testid="annotations-summary-error">
            <p className="text-muted-foreground text-xs leading-5">{t('annotations.loadError')}</p>
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={review.retry}>
              <RotateCcw className="size-3.5" aria-hidden />
              {t('annotations.retry')}
            </Button>
          </div>
        )}
        {ready && live.length === 0 && (
          <p className="text-muted-foreground px-3 pt-3 text-xs leading-5" data-testid="annotations-summary-empty">
            {t('annotations.empty')}
          </p>
        )}
        {ready &&
          live.slice(0, PREVIEWED).map((annotation) => (
            <button
              key={annotation.id}
              type="button"
              data-testid="annotations-summary-row"
              onClick={() => onOpenReview(annotation.id)}
              className="hover:bg-accent/40 border-border/60 flex w-full items-start gap-2.5 border-t px-3 py-2.5 text-left first:border-t-0"
            >
              <CommentPin
                as="span"
                number={annotation.number}
                color={markInk(annotation)}
                proposed={annotation.status === 'proposed'}
              />
              <span className="min-w-0 flex-1">
                <span className="text-foreground line-clamp-2 text-xs leading-5">{annotation.body}</span>
                {/* Not drawn on this Fassung's pages, so the row says where it was set, as the review's list does. */}
                {!annotation.onCurrentFassung && (
                  <span
                    className="text-muted-foreground mt-0.5 block text-[11px] italic"
                    title={t('annotations.earlierFassungHint')}
                    data-testid="annotations-summary-earlier"
                  >
                    {annotation.fassungNumber
                      ? t('annotations.earlierFassung', { number: annotation.fassungNumber })
                      : t('annotations.earlierFassungUnnumbered')}
                  </span>
                )}
              </span>
            </button>
          ))}
        {review.load !== 'error' && (
          <div className={cn('p-2', ready && live.length > 0 && 'border-border/60 border-t')}>
            <Button
              type="button"
              variant={live.length > 0 ? 'ghost' : 'outline'}
              size="sm"
              className="h-8 w-full justify-center gap-1.5"
              data-testid="open-review"
              onClick={() => onOpenReview()}
            >
              <ScanEye className="size-3.5" aria-hidden />
              {live.length > PREVIEWED ? t('annotations.workOnAll', { count: live.length }) : t('annotations.workOn')}
            </Button>
            {others > 0 && (
              <p className="text-muted-foreground mt-1.5 flex flex-wrap items-center justify-center gap-x-1 text-center text-[11px]">
                {t('review.othersHere', { count: others })}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-[11px]"
                  data-testid="annotations-summary-join"
                  onClick={() => onOpenReview()}
                >
                  {t('annotations.joinIn')}
                </Button>
              </p>
            )}
          </div>
        )}
      </InspectorGroup>
    </InspectorSection>
  )
}
