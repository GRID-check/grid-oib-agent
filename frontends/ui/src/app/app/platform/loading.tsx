import { Skeleton } from '@/components/ui/skeleton'
import { getTranslations } from '@/i18n/server'

/**
 * Content-column fallback for the platform segment. The layout already owns
 * the topbar, back link and section nav — this only mirrors the page header
 * + reserved-height stat tiles + cards so the column does not jump when the
 * server page arrives.
 */
export default async function PlatformLoading(): Promise<JSX.Element> {
  const t = await getTranslations('platform')
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">
        {t('loading')}
      </span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[7.25rem] w-full" />
        ))}
      </div>
      <div className="flex flex-col gap-6">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  )
}
