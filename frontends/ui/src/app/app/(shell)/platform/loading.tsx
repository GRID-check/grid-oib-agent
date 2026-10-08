import type { JSX } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { getTranslations } from '@/i18n/server'

/**
 * Content-column fallback for the platform segment. The layout already owns
 * the topbar, back link and section nav, so this is only the page header and
 * one content block.
 *
 * Deliberately neutral. It is the fallback for EVERY section under the
 * segment, and it used to mirror the overview (four stat tiles), so opening
 * Models or Norms flashed a row of tiles those pages do not have and the column
 * jumped when the real page arrived. Each section's own component draws the
 * skeleton shaped like its content.
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
      <Skeleton className="h-64 w-full rounded-lg" />
    </div>
  )
}
