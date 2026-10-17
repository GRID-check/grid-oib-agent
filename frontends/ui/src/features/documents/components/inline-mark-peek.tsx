'use client'

import { useEffect, useRef, useState, type JSX } from 'react'
import { ScanEye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { COMMENT_PIN_ON_POINT, CommentPin } from '@/components/ui/comment-pin'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useTranslations } from '@/i18n'
import type { DocumentReview } from '../hooks/use-document-review'
import { markInk } from './review/review-page-layer'

/** Long enough that crossing a pin on the way somewhere else does not open it. */
const OPEN_DELAY_MS = 130
/** Long enough to travel from the pin into the card without it vanishing. */
const CLOSE_DELAY_MS = 220

/** A pointer that hovers: a mouse or a trackpad. A finger keeps the pin's tap, which opens the review. */
export const HOVER_QUERY = '(hover: hover) and (pointer: fine)'

/**
 * What a pin in the file preview says when the pointer rests on it: the mark's
 * words (three lines), who set it, how many answers it has, and the way into
 * the review at it. A glance, not a decision: before this, the only way to read
 * a mark inline was a click that took the whole screen.
 *
 * It lays itself over one page beside the review's own layer and anchors to an
 * invisible box where that layer draws the pin (the mark's point, the pin
 * standing on it). It follows the review's hover, which the pin sets, so the
 * layer needs no second handler.
 */
export function InlineMarkPeek({
  page,
  review,
  onOpenMark,
}: {
  page: number
  review: DocumentReview
  onOpenMark: (annotationId: string) => void
}): JSX.Element | null {
  const t = useTranslations('files')
  const canHover = useMediaQuery(HOVER_QUERY)
  const [shownId, setShownId] = useState<string | null>(null)
  const inCard = useRef(false)
  const hovered = review.hoveredId
  const hoveredRef = useRef(hovered)

  useEffect(() => {
    hoveredRef.current = hovered
    if (!canHover) return
    const timer = window.setTimeout(
      () => {
        if (hovered) setShownId(hovered)
        else if (!inCard.current) setShownId(null)
      },
      hovered ? OPEN_DELAY_MS : CLOSE_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [hovered, canHover])

  const mark = review.annotations.find(
    (annotation) => annotation.id === shownId && annotation.page === page && annotation.onCurrentFassung
  )
  if (!canHover || !mark) return null
  const author = mark.authorKind === 'piloti' ? 'Piloti' : mark.createdByName
  return (
    <Popover open onOpenChange={(open) => !open && setShownId(null)}>
      <PopoverAnchor asChild>
        <span
          aria-hidden
          className={`absolute size-6 ${COMMENT_PIN_ON_POINT}`}
          style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        className="w-72 p-3"
        data-testid="inline-mark-peek"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={() => {
          inCard.current = true
        }}
        onPointerLeave={() => {
          inCard.current = false
          window.setTimeout(() => {
            if (!inCard.current && !hoveredRef.current) setShownId(null)
          }, CLOSE_DELAY_MS)
        }}
      >
        <div className="flex items-start gap-2.5">
          <CommentPin
            as="span"
            number={mark.number}
            color={markInk(mark)}
            proposed={mark.status === 'proposed'}
          />
          <div className="min-w-0 flex-1">
            <p className="text-foreground line-clamp-3 text-[13px] leading-5">{mark.body}</p>
            <p className="text-muted-foreground mt-1 truncate text-xs">
              {[t(`annotations.kinds.${mark.kind}`), author, mark.replies.length > 0 ? t('annotations.replies', { count: mark.replies.length }) : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 h-8 w-full gap-1.5"
          data-testid="inline-mark-peek-open"
          onClick={() => {
            setShownId(null)
            onOpenMark(mark.id)
          }}
        >
          <ScanEye className="size-3.5" aria-hidden />
          {t('annotations.openInReview')}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
