import type { JSX } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { getTranslations } from '@/i18n/server'

/**
 * Route-level loading state for Project Settings. The page is a server component
 * doing DB work, so without a tailored skeleton the navigation inherits the
 * chat-shaped parent loading state and jumps on arrival. Mirrors the real
 * geometry: header, the brief/insights two-column row, and the stacked sections.
 */
export default async function SettingsLoading(): Promise<JSX.Element> {
  const t = await getTranslations('settings')
  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 md:space-y-10 md:px-8 md:py-10" aria-busy="true">
      <span className="sr-only" role="status">
        {t('loading')}
      </span>

      {/* Header: eyebrow + name */}
      <div className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-40" />
      </div>

      {/* Brief + Insights row */}
      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr] md:gap-[18px]">
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>

      {/* Stacked sections (standards, members, memory) */}
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      ))}
    </div>
  )
}
