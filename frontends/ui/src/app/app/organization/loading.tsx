import { type JSX } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { getTranslations } from '@/i18n/server'

/**
 * Route-level loading state for the organization page. The page is a server
 * component doing WorkOS + DB work, so without this the navigation from the
 * user menu gives no feedback. Mirrors the real page's topbar + back link +
 * header + stacked-card geometry to avoid a layout jump when content arrives.
 */
export default async function OrganizationLoading(): Promise<JSX.Element> {
  const t = await getTranslations('organization')
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

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-8 md:py-10">
        <Skeleton className="mb-6 h-4 w-28" />

        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>

        <div className="mt-6 flex flex-col gap-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      </main>
    </div>
  )
}
