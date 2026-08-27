import { Skeleton } from '@/components/ui/skeleton'
import { PAGE_SHEET_OVERLAY_CLASS, PAGE_SHEET_PANEL_CLASS } from '@/components/ui/page-sheet'

/**
 * The page sheet's loading state — the same scrim and panel geometry as
 * {@link import('@/components/ui/page-sheet').PageSheet}, drawn in plain divs
 * so a route-level `loading.tsx` (a server file) can render it without
 * mounting a dialog. No focus trap: the state lasts one server round-trip, and
 * trapping focus in a skeleton would fight the real sheet arriving.
 *
 * `loadingLabel` is announced (`role="status"`), so the arrival is not silent
 * for a screen-reader user either.
 */
export function PageSheetSkeleton({ loadingLabel }: { loadingLabel: string }): JSX.Element {
  return (
    <div aria-busy="true">
      <div className={PAGE_SHEET_OVERLAY_CLASS} aria-hidden />
      {/* The wide (default) width — both route sheets that use this are wide. */}
      <div className={`${PAGE_SHEET_PANEL_CLASS} md:max-w-[1400px]`}>
        <span className="sr-only" role="status">
          {loadingLabel}
        </span>
        <div className="border-border flex shrink-0 items-center justify-between gap-4 border-b px-4 py-4 md:px-8 md:py-5">
          <div className="flex min-w-0 flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-64" />
          </div>
          <Skeleton className="size-9 rounded-lg" />
        </div>
        <div className="min-h-0 flex-1 space-y-3 px-4 py-6 md:px-8">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-2/3 rounded-xl" />
        </div>
      </div>
    </div>
  )
}
