/**
 * Route-level loading state for the org Archiv.
 *
 * The page is a server component that resolves a session, a feature flag, the
 * reader's active project and its access check before it renders anything — so
 * without this, clicking Archiv left the previous page frozen under a click that
 * appeared to do nothing, and the whole surface then appeared at once.
 *
 * Geometry is the real page's, down to the frame: topbar, back control, and the
 * library sheet with its search row, chip row and card grid. Nothing moves when
 * the content replaces it; only the shimmer stops.
 */

import { Skeleton } from '@/components/ui/skeleton'
import { FileGrid, FileCardSkeleton } from '@/features/documents/components/file-grid'
import { getTranslations } from '@/i18n/server'

export default async function ArchivLoading(): Promise<JSX.Element> {
  const t = await getTranslations('common')
  return (
    <div className="bg-background text-foreground flex h-dvh flex-col" aria-busy="true">
      <span className="sr-only" role="status">
        {t('states.loading')}
      </span>

      {/* Topbar placeholder — same 64px height as OrgTopbar. */}
      <div className="border-border flex h-16 shrink-0 items-center justify-between border-b pl-[18px] pr-10">
        <Skeleton className="h-5 w-16" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-32 rounded-[10px]" />
          <Skeleton className="size-9 rounded-full" />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden px-4 pb-4 md:px-8 md:pb-6">
        <div className="my-3 flex items-center gap-2">
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-4 w-28" />
        </div>

        <div className="shadow-xs flex-1 overflow-hidden rounded-xl border">
          {/* Identity row */}
          <div className="flex items-center gap-3 border-b px-4 py-3.5">
            <Skeleton className="size-9 rounded-xl" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-56 max-w-[50vw]" />
            </div>
          </div>
          {/* Search row */}
          <div className="border-b px-4 py-2.5">
            <Skeleton className="h-9 w-full" />
          </div>
          {/* Category chips */}
          <div className="flex gap-1.5 border-b px-4 py-2">
            {['all', 'a', 'b', 'c'].map((key) => (
              <Skeleton key={key} className="h-8 w-20 rounded-lg" />
            ))}
          </div>
          <div className="p-4">
            <FileGrid>
              {Array.from({ length: 8 }).map((_, i) => (
                <FileCardSkeleton key={i} />
              ))}
            </FileGrid>
          </div>
        </div>
      </div>
    </div>
  )
}
