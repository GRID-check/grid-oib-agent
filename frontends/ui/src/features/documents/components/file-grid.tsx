'use client'

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { RaisedCard, RaisedCardBody, RaisedCardFooter, RaisedCardMedia } from '@/components/ui/raised-card'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The one responsive grid every file surface uses — the Files browser, the
 * Archiv library, and the chat `document_grid`. A single auto-fill template so
 * the shared {@link FileCard} lines up at identical widths and column counts
 * everywhere, instead of the three divergent grids these surfaces used before.
 */
export function FileGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        // `items-stretch` keeps every cell as tall as the row so footers sit on
        // one line; hover must not scale a card (that would shove its neighbours).
        'grid items-stretch gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] sm:gap-3.5 md:[grid-template-columns:repeat(auto-fill,minmax(196px,1fr))]',
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
 * for a skeleton grid that matches the real layout on every surface.
 */
export function FileCardSkeleton() {
  return (
    <RaisedCard>
      <RaisedCardBody className="flex-1 p-0">
        {/* Same reserved well as FileCard — a collapsing thumbnail is a row jump. */}
        <RaisedCardMedia className="h-[124px] min-h-[124px]">
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
