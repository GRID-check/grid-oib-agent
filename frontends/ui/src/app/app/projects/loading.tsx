import { Skeleton } from '@/components/ui/skeleton'
import { getTranslations } from '@/i18n/server'

/**
 * Route-level loading state for the projects list. The page is a server
 * component doing DB work, so without this the navigation gives no feedback.
 * Mirrors the real page's topbar + PageHeader + resume-rail + list geometry
 * so nothing jumps when content arrives.
 */
export default async function ProjectsLoading(): Promise<JSX.Element> {
  const t = await getTranslations('projects')
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground" aria-busy="true">
      <span className="sr-only" role="status">
        {t('list.loading')}
      </span>
      {/* Topbar placeholder — same 64px height and inset as OrgTopbar. */}
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-border pl-[18px] pr-10">
        <Skeleton className="h-5 w-16" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-32 rounded-[10px]" />
          <Skeleton className="size-9 rounded-full" />
        </div>
      </div>

      <main id="main-content" className="flex-1 px-6 pb-10 pt-[34px] md:px-10">
        <div className="mx-auto w-full max-w-[1080px]">
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
        </div>
      </main>
    </div>
  )
}
