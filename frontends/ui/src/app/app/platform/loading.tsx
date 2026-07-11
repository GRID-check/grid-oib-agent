import { Skeleton } from '@/components/ui/skeleton'
import { getTranslations } from '@/i18n/server'

/**
 * Route-level loading state for the platform dashboard. The page is a server
 * component gated on WorkOS session/platform checks, so without this the
 * navigation gives no feedback. Mirrors the real page's topbar + back link +
 * header + stat-tile/card geometry to avoid a layout jump when content arrives.
 */
export default async function PlatformLoading(): Promise<JSX.Element> {
  const t = await getTranslations('platform')
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground" aria-busy="true">
      <span className="sr-only" role="status">
        {t('loading')}
      </span>
      {/* Topbar placeholder */}
      <div className="flex h-14 items-center justify-between border-b border-border px-4 md:px-8">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="size-8 rounded-full" />
      </div>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 md:px-8 md:py-10">
        <Skeleton className="mb-6 h-4 w-28" />

        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>

        {/* Headline stat tiles */}
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[74px] w-full" />
          ))}
        </div>

        {/* Trend + directory cards */}
        <div className="mt-6 flex flex-col gap-6">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </main>
    </div>
  )
}
