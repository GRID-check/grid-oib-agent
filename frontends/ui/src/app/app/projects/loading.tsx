import { Skeleton } from '@/components/ui/skeleton'
import { getTranslations } from '@/i18n/server'

/**
 * Route-level loading state for the projects list. The page is a server
 * component doing DB work, so without this the navigation gives no feedback.
 * Mirrors the real page's topbar + header + card-grid geometry to avoid a
 * layout jump when content arrives.
 */
export default async function ProjectsLoading(): Promise<JSX.Element> {
  const t = await getTranslations('projects')
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground" aria-busy="true">
      <span className="sr-only" role="status">
        {t('list.loading')}
      </span>
      {/* Topbar placeholder */}
      <div className="flex h-14 items-center justify-between border-b border-border px-4 md:px-8">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="size-8 rounded-full" />
      </div>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-8 md:py-10">
        <header className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <div className="space-y-2">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="h-9 w-36" />
        </header>

        <section className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </section>
      </main>
    </div>
  )
}
