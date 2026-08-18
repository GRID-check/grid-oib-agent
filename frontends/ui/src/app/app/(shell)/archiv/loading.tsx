/**
 * Route-level loading state for the org Archiv.
 *
 * The page is a server component that resolves a session, a feature flag, the
 * reader's active project and its access check before it renders anything — so
 * without this, clicking Archiv left the previous page frozen under a click that
 * appeared to do nothing, and the whole surface then appeared at once.
 *
 * Geometry is the real page's, band for band: back control, header, and the
 * library sheet with its search row, chip row and card grid. It draws no
 * topbar — the rail is persistent chrome and is already on screen while this
 * renders — and it uses the same `ShellContent` the page does, so the column
 * cannot be a different width from the thing replacing it.
 */

import { Skeleton } from '@/components/ui/skeleton'
import { ShellContent } from '@/components/shell'
import { FileGrid, FileCardSkeleton } from '@/features/documents/components/file-grid'
import { getTranslations } from '@/i18n/server'

export default async function ArchivLoading(): Promise<JSX.Element> {
  const t = await getTranslations('common')
  return (
    <ShellContent width="wide" fill className="pb-4 md:pb-6" aria-busy="true">
      <span className="sr-only" role="status">
        {t('states.loading')}
      </span>

      <div className="shrink-0 pb-4">
        <div className="mb-4 flex items-center gap-2">
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
      </div>

      <div className="shadow-xs min-h-0 flex-1 overflow-hidden rounded-xl border">
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
    </ShellContent>
  )
}
