'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Range control for a paged list.
 *
 * The admin lists rendered every row they had, unbounded — fine at twenty
 * documents, not at eight hundred. This is the smallest control that fixes
 * that honestly: it states the range and the total, so nobody has to guess
 * whether they are looking at everything.
 *
 * Prev/next only, deliberately. Numbered pages are noise on a list you filter
 * and sort rather than navigate by ordinal.
 */

export interface PaginationProps {
  /** 0-based index of the first visible item. */
  offset: number
  pageSize: number
  total: number
  onOffsetChange: (offset: number) => void
  /** e.g. `(from, to, total) => \`${from}–${to} of ${total}\`` */
  rangeLabel: (from: number, to: number, total: number) => string
  previousLabel: string
  nextLabel: string
  className?: string
}

export function Pagination({
  offset,
  pageSize,
  total,
  onOffsetChange,
  rangeLabel,
  previousLabel,
  nextLabel,
  className,
}: PaginationProps): JSX.Element | null {
  // One page of results needs no pager — the range label would only restate
  // the row count already visible.
  if (total <= pageSize) return null

  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + pageSize, total)

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-2 pt-1', className)}>
      <p className="text-xs tabular-nums text-muted-foreground">{rangeLabel(from, to, total)}</p>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}
        >
          <ChevronLeft className="size-4" aria-hidden />
          {previousLabel}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={to >= total}
          onClick={() => onOffsetChange(offset + pageSize)}
        >
          {nextLabel}
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  )
}
