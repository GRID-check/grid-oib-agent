import type { JSX } from 'react'
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
 */
export default async function ProjectsLoading(): Promise<JSX.Element> {
  const t = await getTranslations('projects')
  return (
    <ShellContent width="wide" aria-busy="true">
      <span className="sr-only" role="status">
        {t('list.loading')}
      </span>

      {/* Title + primary action — the real page has no subtitle here. */}
      <header className="flex min-h-9 flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-36" />
      </header>

      {/* Resume rail (three cards) then the dense list — the page's real shape. */}
      <div className="mt-7 flex flex-col gap-8">
        <section>
          <Skeleton className="mb-3 h-3 w-40" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        </section>
        <section>
          <Skeleton className="mb-3 h-3 w-28" />
          <div className="space-y-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        </section>
      </div>
    </ShellContent>
  )
}
