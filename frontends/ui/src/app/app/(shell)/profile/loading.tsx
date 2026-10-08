import type { JSX } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { ShellContent } from '@/components/shell'
import { getTranslations } from '@/i18n/server'

/**
 * Route-level loading state for the profile page. The page is a server
 * component reading the WorkOS session, so without this the navigation from the
 * user menu gives no feedback.
 *
 * It draws no topbar. The chrome is persistent and already on screen, and a copy
 * of the topbar here would drift from the real one and move the whole column on
 * arrival. The column below comes from the same `ShellContent` the page itself
 * uses.
 */
export default async function ProfileLoading(): Promise<JSX.Element> {
  const t = await getTranslations('profile')
  return (
    <ShellContent aria-busy="true">
      <span className="sr-only" role="status">
        {t('loading')}
      </span>

      <Skeleton className="mb-6 h-6 w-28 rounded-full" />

      <div className="mb-8 space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      <div className="flex flex-col gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-44 w-full" />
        ))}
      </div>
    </ShellContent>
  )
}
