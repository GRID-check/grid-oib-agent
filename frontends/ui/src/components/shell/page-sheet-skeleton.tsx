import { Skeleton } from '@/components/ui/skeleton'
import { PAGE_SHEET_OVERLAY_CLASS, PAGE_SHEET_PANEL_CLASS } from '@/components/ui/page-sheet'

/**
 * The page sheet's loading state — the same scrim and panel geometry as
 * {@link import('@/components/ui/page-sheet').PageSheet}, drawn in plain divs
 * so a route-level `loading.tsx` (a server file) can render it without
 * mounting a dialog. No focus trap: the state lasts one server round-trip, and
 * trapping focus in a skeleton would fight the real sheet arriving.
 *
 * It ARRIVES like the sheet it stands in for — the same rise on the same
 * curve, in CSS since there is no client component here. It used to pop in at
 * full opacity, so the flow read as a hard cut followed by the real sheet's
 * second, redundant rise; now the skeleton's rise IS the sheet's arrival and
 * the content swap underneath it is just a repaint.
 *
 * `loadingLabel` is announced (`role="status"`), so the arrival is not silent
 * for a screen-reader user either.
 */
export function PageSheetSkeleton({ loadingLabel }: { loadingLabel: string }): JSX.Element {
  return (
    <div aria-busy="true">
      <div
        className={`${PAGE_SHEET_OVERLAY_CLASS} animate-in fade-in-0 duration-base ease-entrance motion-reduce:animate-none`}
        aria-hidden
      />
      {/* The wide (default) width — both route sheets that use this are wide. */}
      <div
        className={`${PAGE_SHEET_PANEL_CLASS} md:max-w-[1400px] animate-in fade-in-0 slide-in-from-bottom duration-deliberate ease-entrance motion-reduce:animate-none`}
      >
        <span className="sr-only" role="status">
          {loadingLabel}
        </span>
        {/* The grabber band, mirroring the sheet's chrome so the pill does not
            jump when the real sheet takes over. Inert here: there is nothing
            to pull yet. */}
        <div className="flex shrink-0 justify-center py-2" aria-hidden>
          <div className="bg-muted-foreground/25 h-1 w-9 rounded-full" />
        </div>
        <div className="border-border flex shrink-0 items-start justify-between gap-4 border-b px-4 pb-4 pt-2 md:px-8 md:pb-5 md:pt-3">
          <div className="flex min-w-0 flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-64" />
          </div>
          <Skeleton className="hidden size-9 rounded-lg md:block" />
        </div>
        <div className="min-h-0 flex-1 space-y-3 px-4 py-6 md:px-8">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-2/3 rounded-lg" />
        </div>
      </div>
    </div>
  )
}
