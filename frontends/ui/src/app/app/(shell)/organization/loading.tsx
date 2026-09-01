import type { JSX } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { getTranslations } from '@/i18n/server'

/**
 * Content-column fallback for the organization segment. The layout already
 * owns the topbar, back link and section nav — this only mirrors the page
 * header + stacked-card geometry so the column does not jump when the
 * server page arrives.
 */
export default async function OrganizationLoading(): Promise<JSX.Element> {
  const t = await getTranslations('organization')
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">
        {t('loading')}
      </span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="flex flex-col gap-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-44 w-full" />
        ))}
      </div>
    </div>
  )
}
