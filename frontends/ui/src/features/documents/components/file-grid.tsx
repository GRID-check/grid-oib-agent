'use client'

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  RaisedCard,
  RaisedCardBody,
  RaisedCardFooter,
  RaisedCardMedia,
} from '@/components/ui/raised-card'
import { Skeleton } from '@/components/ui/skeleton'
import { FILE_CARD_MEDIA, FILE_GRID_TEMPLATE, type FileCardSize } from './file-card-size'

/**
 * The one responsive grid every file surface uses — the Files browser, the
 * Archiv library, and the chat `document_grid`. A single auto-fill template so
 * the shared {@link FileCard} lines up at identical widths and column counts
 * everywhere, instead of the three divergent grids these surfaces used before.
 *
 * `size` picks WHICH of the two documented metrics (see {@link FileCardSize});
 * it does not let a caller invent a third.
 */
export function FileGrid({
  children,
  className,
  size = 'compact',
}: {
  children: ReactNode
  className?: string
  size?: FileCardSize
}) {
  return (
    <div
      className={cn(
        // `items-stretch` keeps every cell as tall as the row so footers sit on
        // one line; hover must not scale a card (that would shove its neighbours).
        'grid items-stretch gap-3 sm:gap-3.5',
        FILE_GRID_TEMPLATE[size],
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * One loading cell shaped like the raised {@link FileCard} (proud block +
 * thumbnail + two text lines + footer). Render several inside a {@link FileGrid}
 * for a skeleton grid that matches the real layout on every surface — pass the
 * SAME `size` the grid got, or the placeholder is a shape the answer will not
 * arrive in.
 */
export function FileCardSkeleton({ size = 'compact' }: { size?: FileCardSize }) {
  return (
    <RaisedCard>
      <RaisedCardBody className="flex-1 p-0">
        {/* Same reserved well as FileCard — a collapsing thumbnail is a row jump. */}
        <RaisedCardMedia className={FILE_CARD_MEDIA[size]}>
          <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
        </RaisedCardMedia>
        <div className="min-h-[4.5rem] space-y-2 px-3.5 pb-3 pt-[11px]">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-full" />
        </div>
      </RaisedCardBody>
      <RaisedCardFooter className="min-h-[30px] gap-1.5 px-3.5 pb-2.5 pt-[9px]">
        <Skeleton className="ml-auto h-3 w-24" />
      </RaisedCardFooter>
    </RaisedCard>
  )
}
