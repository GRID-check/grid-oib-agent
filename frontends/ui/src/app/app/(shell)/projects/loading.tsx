import { Skeleton } from '@/components/ui/skeleton'
import { ShellContent } from '@/components/shell'
import { getTranslations } from '@/i18n/server'

/**
 * Route-level loading state for the projects list. The page is a server
 * component doing DB work, so without this the navigation gives no feedback.
 *
 * It draws the CONTENT COLUMN only. The rail, the `<main>` landmark and the
 * scroll container belong to the persistent shell and are already on screen
 * while this renders — a fallback that re-drew a topbar was drawing chrome that
 * no longer moves, and drawing it at the wrong height was how the profile
 * fallback shipped an 8px jump.
 *
 * Every block mirrors the real surface's box 1:1 (header `min-h-9` with a
 * search-width + button-width action, `RaisedCard` body/footer padding,
 * `h-11 rounded-lg` rows in a `space-y-1` list) so arrival swaps content
 * without moving it. All heights are fixed — nothing here sizes to content,
 * which is what keeps the fallback from collapsing and jumping (CLS).
 */
export default async function ProjectsLoading(): Promise<JSX.Element> {
  const t = await getTranslations('projects')
  return (
    <ShellContent width="wide" aria-busy="true">
      <span className="sr-only" role="status">
        {t('list.loading')}
      </span>

      {/* Title + action row — the real header is `min-h-9` with a search field
          (`h-9`, `sm:w-64`) and the New-project button (`h-9`) beside it. */}
      <header className="flex min-h-9 flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <Skeleton className="h-7 w-40" />
        <div className="flex w-full items-center gap-2.5 sm:w-auto">
          <Skeleton className="h-9 w-full rounded-lg sm:w-64" />
          <Skeleton className="h-9 w-36 shrink-0 rounded-lg" />
        </div>
      </header>

      {/* Resume rail (three cards) then the dense list — the page's real shape. */}
      <div className="mt-7 flex flex-col gap-8">
        <section>
          <Skeleton className="mb-3 h-3 w-40" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              // A `RaisedCard` at rest: tray + laid-in body (`px-4 pb-3 pt-3.5`,
              // title row with status chip, summary line) + footer tab
              // (`px-4 py-2.5`, timestamp + gear). `min-h-28` holds the card's
              // ~114px even before the blocks paint.
              <div
                key={i}
                className="flex min-h-28 flex-col overflow-hidden rounded-lg border border-border bg-muted/50"
              >
                <div className="rounded-b-lg bg-card px-4 pb-3 pt-3.5 shadow-xs">
                  <div className="flex items-center justify-between gap-2.5">
                    <Skeleton className="h-5 w-2/3 rounded-md" />
                    <Skeleton className="h-6 w-16 shrink-0 rounded-md" />
                  </div>
                  <Skeleton className="mt-0.5 h-4 w-11/12 rounded-md" />
                </div>
                <div className="mt-auto flex items-center gap-2 px-4 py-2.5">
                  <Skeleton className="ml-auto h-4 w-28 rounded-md" />
                  <Skeleton className="size-7 shrink-0 rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        </section>
        <section>
          <Skeleton className="mb-3 h-3 w-28" />
          <div className="space-y-1">
            {/* A `ProjectListRow`: initials tile, name, doc-count column,
                timestamp column, gear — `h-11 rounded-lg border`, as listed. */}
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="flex h-11 items-center gap-3 rounded-lg border border-border px-3"
              >
                <Skeleton className="hidden size-9 shrink-0 sm:block" />
                <div className="min-w-0 flex-1">
                  <Skeleton
                    className={
                      i % 2 === 0 ? 'h-4 w-1/3 rounded-md' : 'h-4 w-1/4 rounded-md'
                    }
                  />
                </div>
                <Skeleton className="hidden h-4 w-[104px] shrink-0 rounded-md lg:block" />
                <Skeleton className="h-4 w-[72px] shrink-0 rounded-md sm:w-[104px]" />
                <Skeleton className="size-7 shrink-0 rounded-lg" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </ShellContent>
  )
}
