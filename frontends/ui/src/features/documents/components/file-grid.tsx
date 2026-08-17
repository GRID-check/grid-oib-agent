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
        'grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] sm:gap-3.5 md:[grid-template-columns:repeat(auto-fill,minmax(196px,1fr))]',
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
      <RaisedCardBody className="p-0">
        <RaisedCardMedia className="h-[124px]">
          <Skeleton className="h-[124px] w-full rounded-none" />
        </RaisedCardMedia>
        <div className="space-y-2 px-3.5 pb-3 pt-[11px]">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-full" />
        </div>
      </RaisedCardBody>
      <RaisedCardFooter className="px-3.5 pb-2.5 pt-[9px]">
        <Skeleton className="ml-auto h-3 w-24" />
      </RaisedCardFooter>
    </RaisedCard>
  )
}
